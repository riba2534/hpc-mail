import { API_SCOPES, type ApiScope, type CreatedApiKey, type MessageDetail, type MessageSummary,
  type MultipartInitResult, type MultipartPartResult, type SingleUploadResult } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { handleInbound } from '../src/services/inbound.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();

async function request(path: string | Request, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }
function json(token: string, body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

async function actor(username: string, role: 'admin' | 'user' = 'user', scopes: ApiScope[] = [...API_SCOPES]) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'private.test', public: false, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await createDb(env).insert(users).values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await request('/api/api-keys', json(jwt, { name: `${username}-agent`, scopes, rateLimit: 120 })), 201);
  expect(key.scopes).toEqual(scopes);
  return { id: user!.id, jwt, key: key.key };
}

async function claim(key: string, localPart: string) {
  return data<{ id: number; address: string; displayName: string }>(await request('/v1/mailboxes', json(key, { localPart, domain: 'hpc.email' })), 201);
}

async function receive(address: string, subject: string, messageId: string) {
  const raw = `From: Original Sender <sender@example.net>\r\nTo: ${address}\r\nMessage-ID: <${messageId}@example.net>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nOriginal body 中文\r\n`;
  const ctx = createExecutionContext();
  await handleInbound({ to: address, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
  const row = await createDb(env).select().from(messages).where(eq(messages.messageId, `<${messageId}@example.net>`)).get();
  return { id: row!.id, raw };
}

describe('外部 Agent API 真实 HTTP 工作流', () => {
  it('JWT 与 Key 均识别清历史 true，非法布尔值拒绝且不释放邮箱', async () => {
    const owner = await actor('agent-history-flag');
    for (const [prefix, token, label] of [['/api/mailboxes', owner.jwt, 'jwt'], ['/v1/mailboxes', owner.key, 'key']]) {
      expect((await request(`${prefix}?all=true`, { headers: auth(token!) })).status).toBe(403);
      const box = await claim(owner.key, `agent-history-flag-${label}`);
      const received = await receive(box.address, 'Delete history flag', `agent-history-${label}`);
      expect((await request(`${prefix}/${box.id}?deleteHistory=treu`, { method: 'DELETE', headers: auth(token!) })).status).toBe(400);
      const owned = await data<{ id: number }[]>(await request(prefix!, { headers: auth(token!) }));
      expect(owned.map(item => item.id)).toContain(box.id);
      const released = await data<{ success: boolean; deletedMessages: number }>(await request(`${prefix}/${box.id}?deleteHistory=true`, { method: 'DELETE', headers: auth(token!) }));
      expect(released).toEqual({ success: true, deletedMessages: 1 });
      expect(await createDb(env).select().from(messages).where(eq(messages.id, received.id)).get()).toBeUndefined();
    }
  });

  it('非法 base64 在开始投递前返回参数错误而非可重试的服务器错误', async () => {
    const owner = await actor('agent-invalid-base64');
    for (const [path, token] of [['/api/messages/send', owner.jwt], ['/v1/messages', owner.key]]) {
      for (const content of ['a', 'YQ=', 'YQ===', 'YWJj=']) {
        const response = await request(path!, json(token!, { from: { localPart: 'agent-invalid', domain: 'hpc.email' }, to: ['recipient@hpc.email'],
          subject: 'Invalid base64', text: 'body', attachments: [{ filename: 'proof.txt', contentType: 'text/plain', content }] }));
        expect(response.status, content).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'validation_failed' } });
      }
    }
  });

  it('JWT 建 key → claim/upload → 幂等站内回复 → detail/download/thread/raw → star/read/trash/release', async () => {
    const owner = await actor('agent-workflow');
    const available = await data<{ available: boolean }>(await request('/v1/mailboxes/availability?localPart=agent-workflow-from&domain=hpc.email', { headers: auth(owner.key) }));
    expect(available.available).toBe(true);
    const from = await claim(owner.key, 'agent-workflow-from');
    const receiver = await claim(owner.key, 'agent-workflow-to');
    const renamed = await data<{ displayName: string }>(await request(`/v1/mailboxes/${from.id}`, json(owner.key, { displayName: 'Agent Sender' }, 'PUT')));
    expect(renamed.displayName).toBe('Agent Sender');
    const original = await receive(receiver.address, 'Agent protocol thread', 'agent-workflow-original');
    const bytes = new Uint8Array([11, 22, 33]);
    const uploaded = await data<SingleUploadResult>(await request('/v1/uploads?filename=proof.bin&mimeType=application%2Foctet-stream', {
      method: 'POST', headers: { ...auth(owner.key), 'Content-Length': '3' }, body: bytes,
    }), 201);
    const payload = { from: { mailboxId: from.id }, to: [receiver.address], subject: 'Re: Agent protocol thread',
      text: 'API key 回复正文', replyToMessageId: original.id, attachmentTokens: [uploaded.token] };
    const sendInit = json(owner.key, payload);
    sendInit.headers = { ...sendInit.headers, 'Idempotency-Key': 'agent-workflow-once' };
    const sent = await data<MessageSummary>(await request('/v1/messages', sendInit), 201);
    expect(sent.status).toBe('delivered');
    expect(sent.recipientOutcomes).toEqual([{ address: receiver.address, status: 'delivered' }]);
    const replay = await data<MessageSummary>(await request('/v1/messages', sendInit), 201);
    expect(replay.id).toBe(sent.id);
    const listed = await data<{ items: MessageSummary[] }>(await request(`/v1/messages?address=${receiver.address}&afterId=0`, { headers: auth(owner.key) }));
    const deliveries = listed.items.filter(item => item.subject === payload.subject);
    expect(deliveries).toHaveLength(1);
    const incoming = deliveries[0]!;
    const detail = await data<MessageDetail>(await request(`/v1/messages/${incoming.id}`, { headers: auth(owner.key) }));
    expect(detail.bodyText).toBe(payload.text);
    expect(detail.attachments).toHaveLength(1);
    const attachment = await request(`/v1/messages/${incoming.id}/attachments/${detail.attachments[0]!.id}`, { headers: auth(owner.key) });
    expect(attachment.status).toBe(200);
    expect(new Uint8Array(await attachment.arrayBuffer())).toEqual(bytes);
    const signed = await request(detail.attachments[0]!.url);
    expect(signed.status).toBe(200);
    expect(new Uint8Array(await signed.arrayBuffer())).toEqual(bytes);
    const thread = await data<{ items: MessageSummary[] }>(await request(`/v1/messages/${incoming.id}/thread`, { headers: auth(owner.key) }));
    expect(thread.items.map(item => item.id)).toEqual(expect.arrayContaining([original.id, sent.id, incoming.id]));
    const raw = await request(`/v1/messages/${original.id}/raw`, { headers: auth(owner.key) });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('Content-Type')).toBe('message/rfc822');
    expect(await raw.text()).toBe(original.raw);
    expect((await request(`/v1/messages/${incoming.id}/raw`, { headers: auth(owner.key) })).status).toBe(404);
    const waited = await data<{ message: MessageDetail | null }>(await request(`/v1/messages/wait?address=${receiver.address}&afterId=${original.id}&timeout=1`, { headers: auth(owner.key) }));
    expect(waited.message?.id).toBe(incoming.id);
    expect((await data<{ contacts: string[] }>(await request('/v1/messages/contacts', { headers: auth(owner.key) }))).contacts).toContain(receiver.address);
    expect((await data<{ unread: number }>(await request('/v1/messages/unread-count', { headers: auth(owner.key) }))).unread).toBe(2);
    expect((await data<{ changed: number }>(await request('/v1/messages/star', json(owner.key, { ids: [incoming.id], starred: true })))).changed).toBe(1);
    expect((await data<MessageDetail>(await request(`/v1/messages/${incoming.id}`, { headers: auth(owner.key) }))).isStarred).toBe(true);
    expect((await data<{ changed: number }>(await request('/v1/messages/read-all', { method: 'POST', headers: auth(owner.key) }))).changed).toBe(2);
    expect((await data<{ unread: number }>(await request('/v1/messages/unread-count', { headers: auth(owner.key) }))).unread).toBe(0);
    expect((await data<{ deleted: number }>(await request('/v1/messages/delete', json(owner.key, { ids: [incoming.id] })))).deleted).toBe(1);
    const trash = await data<{ items: MessageSummary[] }>(await request('/v1/messages?trash=1', { headers: auth(owner.key) }));
    expect(trash.items.map(item => item.id)).toContain(incoming.id);
    expect((await data<{ restored: number }>(await request('/v1/messages/restore', json(owner.key, { ids: [incoming.id] })))).restored).toBe(1);
    await data(await request('/v1/messages/delete', json(owner.key, { ids: [incoming.id] })));
    expect((await data<{ purged: number }>(await request('/v1/messages/purge', json(owner.key, { ids: [incoming.id] })))).purged).toBe(1);
    expect((await request(`/v1/messages/${incoming.id}`, { headers: auth(owner.key) })).status).toBe(404);
    const released = await data<{ success: boolean; deletedMessages: number }>(await request(`/v1/mailboxes/${receiver.id}?deleteHistory=1`, { method: 'DELETE', headers: auth(owner.key) }));
    expect(released).toEqual({ success: true, deletedMessages: 1 });
    expect((await data<{ id: number }[]>(await request('/v1/mailboxes', { headers: auth(owner.key) }))).map(item => item.id)).not.toContain(receiver.id);
    expect((await request(`/v1/messages/${original.id}`, { headers: auth(owner.key) })).status).toBe(404);
  });

  it('API key 支持分片上传所有阶段，草稿严格隔离账号', async () => {
    const owner = await actor('agent-multipart', 'user', ['mail.send']);
    const other = await actor('agent-multipart-other', 'user', ['mail.send']);
    const initialized = await data<MultipartInitResult>(await request('/v1/uploads/multipart', json(owner.key, { filename: 'part.bin', mimeType: 'application/octet-stream', size: 3 })), 201);
    expect(initialized.partCount).toBe(1);
    const path = `/v1/uploads/multipart/${initialized.token}/parts/1`;
    expect((await request(path, { method: 'PUT', headers: { ...auth(other.key), 'Content-Length': '3' }, body: new Uint8Array([1, 2, 3]) })).status).toBe(404);
    const part = await data<MultipartPartResult>(await request(path, { method: 'PUT', headers: { ...auth(owner.key), 'Content-Length': '3' }, body: new Uint8Array([1, 2, 3]) }));
    const completePath = `/v1/uploads/multipart/${initialized.token}/complete`;
    expect((await request(completePath, json(other.key, { parts: [part] }))).status).toBe(404);
    expect((await data<{ size: number }>(await request(completePath, json(owner.key, { parts: [part] })))).size).toBe(3);
    expect((await request(`/v1/uploads/${initialized.token}`, { method: 'DELETE', headers: auth(other.key) })).status).toBe(404);
    expect((await data<{ success: boolean }>(await request(`/v1/uploads/${initialized.token}`, { method: 'DELETE', headers: auth(owner.key) }))).success).toBe(true);
  });

  it('最小 scope、普通用户范围和私有域名均由服务端限制', async () => {
    const owner = await actor('agent-owner-permissions');
    const box = await claim(owner.key, 'agent-owner-permissions');
    const reader = await actor('agent-reader-permissions', 'user', ['mail.read', 'mailbox.read']);
    for (const [path, init] of [
      ['/v1/mailboxes', json(reader.key, { localPart: 'agent-reader-write', domain: 'hpc.email' })],
      [`/v1/mailboxes/${box.id}`, json(reader.key, { displayName: 'forbidden' }, 'PUT')],
      [`/v1/mailboxes/${box.id}`, { method: 'DELETE', headers: auth(reader.key) }],
      ['/v1/messages/star', json(reader.key, { ids: [1] })],
      ['/v1/uploads?filename=x.bin', { method: 'POST', headers: { ...auth(reader.key), 'Content-Length': '1' }, body: new Uint8Array([1]) }],
    ] as [string, RequestInit][]) expect((await request(path, init)).status, path).toBe(403);
    const writer = await actor('agent-writer-permissions');
    expect((await request(`/v1/mailboxes/${box.id}`, json(writer.key, { displayName: 'forbidden' }, 'PUT'))).status).toBe(404);
    expect((await request(`/v1/mailboxes/${box.id}`, { method: 'DELETE', headers: auth(writer.key) })).status).toBe(404);
    expect((await request('/v1/mailboxes?all=1', { headers: auth(writer.key) })).status).toBe(403);
    expect((await request('/v1/mailboxes?all=anything', { headers: auth(writer.key) })).status).toBe(400);
    expect((await data<{ available: boolean }>(await request('/v1/mailboxes/availability?localPart=private-user&domain=private.test', { headers: auth(writer.key) }))).available).toBe(false);
    expect((await request('/v1/mailboxes/availability?localPart=bad%40prefix&domain=hpc.email', { headers: auth(writer.key) })).status).toBe(400);
    const admin = await actor('agent-admin-permissions', 'admin', ['mailbox.read']);
    expect(await data(await request('/v1/mailboxes', { headers: auth(admin.key) }))).toEqual([]);
    expect((await data<{ id: number }[]>(await request('/v1/mailboxes?all=1', { headers: auth(admin.key) }))).map(item => item.id)).toContain(box.id);
    expect((await data<{ available: boolean }>(await request('/v1/mailboxes/availability?localPart=private-admin&domain=private.test', { headers: auth(admin.key) }))).available).toBe(true);
    expect((await request('/api/api-keys', { headers: auth(writer.key) })).status).toBe(401);
    expect((await request('/api/admin/users', { headers: auth(writer.key) })).status).toBe(401);
  });

  it('query/body mutation scope 在 JWT 与 API key 中一致，冲突和非法值不降级', async () => {
    const admin = await actor('agent-scope-admin', 'admin');
    const user = await actor('agent-scope-user');
    const unclaimed = await receive('agent-unclaimed-scope@hpc.email', 'Unclaimed scope', 'agent-unclaimed-scope');
    for (const [prefix, token] of [['/api/messages', admin.jwt], ['/v1/messages', admin.key]]) {
      await createDb(env).update(messages).set({ isRead: false }).where(eq(messages.id, unclaimed.id));
      expect((await data<{ changed: number }>(await request(`${prefix}/read`, json(token!, { ids: [unclaimed.id], scope: 'unclaimed' })))).changed).toBe(1);
      await createDb(env).update(messages).set({ isRead: false }).where(eq(messages.id, unclaimed.id));
      expect((await data<{ changed: number }>(await request(`${prefix}/read?scope=unclaimed`, json(token!, { ids: [unclaimed.id] })))).changed).toBe(1);
      expect((await request(`${prefix}/read?scope=mine`, json(token!, { ids: [unclaimed.id], scope: 'unclaimed' }))).status).toBe(400);
      expect((await request(`${prefix}/star?scope=user&userId=${user.id}`, json(token!, { ids: [unclaimed.id] }))).status).toBe(400);
      expect((await request(`${prefix}/delete?scope=all`, json(token!, { ids: [unclaimed.id] }))).status).toBe(400);
      expect((await request(`${prefix}/${unclaimed.id}?scope=all`, { headers: auth(token!) })).status).toBe(400);
      expect((await request(`${prefix}/${unclaimed.id}?scope=user`, { headers: auth(token!) })).status).toBe(400);
      expect((await data<{ changed: number }>(await request(`${prefix}/read-all?scope=unclaimed`, { method: 'POST', headers: auth(token!) }))).changed).toBeGreaterThanOrEqual(0);
    }
    for (const [prefix, token] of [['/api/messages', user.jwt], ['/v1/messages', user.key]]) {
      expect((await request(`${prefix}/read`, json(token!, { ids: [unclaimed.id], scope: 'unclaimed' }))).status).toBe(403);
      expect((await request(`${prefix}/read?scope=unclaimed`, json(token!, { ids: [unclaimed.id] }))).status).toBe(403);
      expect((await request(`${prefix}?scope=unclaimed`, { headers: auth(token!) })).status).toBe(403);
      expect((await request(`${prefix}/${unclaimed.id}?scope=unclaimed`, { headers: auth(token!) })).status).toBe(403);
    }
  });

  it('共享邮箱只授权收件阅读、已读和个人星标，不授权发件及破坏性操作', async () => {
    const owner = await actor('agent-shared-owner', 'admin');
    const viewer = await actor('agent-shared-reader');
    const box = await claim(owner.key, 'agent-shared-owned');
    await data(await request('/api/admin/mailbox-shares', json(owner.jwt, { mailboxId: box.id, userIds: [viewer.id] }, 'PUT')));
    const received = await receive(box.address, 'Shared agent mail', 'agent-shared-source');
    const shared = await data<{ address: string }[]>(await request('/v1/mailboxes/shared', { headers: auth(viewer.key) }));
    expect(shared.map(item => item.address)).toContain(box.address);
    const detail = await data<MessageDetail>(await request(`/v1/messages/${received.id}`, { headers: auth(viewer.key) }));
    expect(detail.bodyText).toContain('Original body');
    const thread = await data<{ items: MessageSummary[] }>(await request(`/v1/messages/${received.id}/thread`, { headers: auth(viewer.key) }));
    expect(thread.items.map(item => item.id)).toContain(received.id);
    const raw = await request(`/v1/messages/${received.id}/raw`, { headers: auth(viewer.key) });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(received.raw);
    expect((await data<{ changed: number }>(await request('/v1/messages/star', json(viewer.key, { ids: [received.id] })))).changed).toBe(1);
    expect((await data<{ changed: number }>(await request('/v1/messages/read', json(viewer.key, { ids: [received.id] })))).changed).toBe(1);
    expect((await data<{ deleted: number }>(await request('/v1/messages/delete', json(viewer.key, { ids: [received.id] })))).deleted).toBe(0);
    expect((await data<{ restored: number }>(await request('/v1/messages/restore', json(viewer.key, { ids: [received.id] })))).restored).toBe(0);
    expect((await data<{ purged: number }>(await request('/v1/messages/purge', json(viewer.key, { ids: [received.id] })))).purged).toBe(0);
    expect((await request('/v1/messages', json(viewer.key, { from: { mailboxId: box.id }, to: ['inside@hpc.email'], subject: 'Forbidden', text: 'body' }))).status).toBe(403);
    expect((await request(`/v1/mailboxes/${box.id}`, json(viewer.key, { displayName: 'forbidden' }, 'PUT'))).status).toBe(404);
    expect((await request(`/v1/mailboxes/${box.id}`, { method: 'DELETE', headers: auth(viewer.key) })).status).toBe(404);
  });

  it('wait 严格校验参数，并在取消后停止 D1 轮询', async () => {
    const owner = await actor('agent-wait-validation', 'user', ['mail.read']);
    for (const query of ['afterId=-1', 'afterId=NaN', 'afterId=9007199254740993', 'timeout=NaN', 'timeout=0', 'timeout=51', 'address=invalid']) {
      expect((await request(`/v1/messages/wait?${query}`, { headers: auth(owner.key) })).status, query).toBe(400);
    }
    const minute = minuteWindow(1);
    expect((await readCounter(env, 'api-wait', String(owner.id), minute)).count).toBe(0);
    const controller = new AbortController();
    const started = Date.now();
    const pending = request(new Request('https://example.test/v1/messages/wait?timeout=50&afterId=0', { headers: auth(owner.key), signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    expect(await data(await pending)).toEqual({ message: null });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await readCounter(env, 'api-wait', String(owner.id), minute)).count).toBe(1);
    const timeoutStarted = Date.now();
    expect(await data(await request('/v1/messages/wait?timeout=1&afterId=0', { headers: auth(owner.key) }))).toEqual({ message: null });
    expect(Date.now() - timeoutStarted).toBeLessThan(1600);
  });

  it('浏览器 Agent 的 PUT/DELETE 预检可以通过，发现链接允许跨源读取', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const response = await request('/v1/mailboxes/1', { method: 'OPTIONS', headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Authorization,Content-Type' } });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain(method);
    }
    const response = await request('/v1/status', { headers: { Origin: 'https://agent.example' } });
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Link');
  });
});
