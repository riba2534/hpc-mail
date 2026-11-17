import type { ApiScope, CreatedWebhookEndpoint, Page, WebhookDelivery, WebhookEndpoint, WebhookTestResult } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { eq } from 'drizzle-orm';
import { mailboxes, users } from '../src/db/schema.js';
import { hmacSha256Base64 } from '../src/lib/crypto.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { handleInbound } from '../src/services/inbound.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { sendNotifyWebhook, signingKeyBytes } from '../src/services/webhook-notify.js';
import { emitHostedDomainTransitions, processWebhookDeliveries } from '../src/services/webhooks.js';

const app = createApp();
const db = createDb(env);
let seq = 0;

afterEach(() => vi.unstubAllGlobals());

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string, body: unknown, method = 'POST'): RequestInit =>
  ({ method, headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

interface Hit { url: string; headers: Headers; body: string }
/** 拦下发往接收端的请求；status 决定接收端的响应 */
function receiver(status: (hit: Hit) => number = () => 200) {
  const hits: Hit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const hit = { url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? '') };
    hits.push(hit);
    return new Response('ok', { status: status(hit) });
  }));
  return hits;
}

async function verify(secret: string, hit: Hit): Promise<boolean> {
  const id = hit.headers.get('webhook-id')!;
  const timestamp = hit.headers.get('webhook-timestamp')!;
  const expected = await hmacSha256Base64(signingKeyBytes(secret), `${id}.${timestamp}.${hit.body}`);
  return hit.headers.get('webhook-signature') === `v1,${expected}`;
}

async function account(name: string) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    api: { enabled: true }, security: { require2fa: false }, code_extract: { enabled: true, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
  });
  const [user] = await db.insert(users).values({ username: `wh-${name}-${++seq}`, role: 'user', passwordHash: 'x',
    status: 'active', authVersionMigrated: true }).returning();
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid: await createSession(env, user!.id), epoch: 0, uepoch: 0 });
  const key = async (scopes: ApiScope[], extra: { allowedMailboxIds?: number[]; allowedDomains?: string[] } = {}) =>
    (await createApiKey(env, user!.id, { name: `k-${++seq}`, scopes, rateLimit: 600, allowedIps: [], ...extra })).key;
  const box = (await db.insert(mailboxes).values({ address: `wh-${name}-${seq}@hpc.email`, domain: 'hpc.email', userId: user!.id }).returning().get())!;
  return { id: user!.id, jwt, key, box };
}

async function receive(address: string, subject: string) {
  const raw = `From: Sender <sender@example.net>\r\nTo: ${address}\r\nCc: cc@example.net\r\nMessage-ID: <wh-${++seq}@example.net>\r\nSubject: ${subject}\r\n`
    + `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nYour verification code is 482913\r\n`
    + `--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n--b--\r\n`;
  const ctx = createExecutionContext();
  await handleInbound({ to: address, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
}

const create = (token: string, body: Record<string, unknown>, prefix = '/api') =>
  request(`${prefix}/webhooks`, json(token, { url: 'https://hooks.example.com/hpc', events: ['mail.received'], ...body }));

describe('Webhook v2 端点管理', () => {
  it('创建返回一次性 whsec_ 密钥，列表只给前缀；网页会话与 webhook.write Key 同形；地址校验拦内网与本站', async () => {
    const user = await account('crud');
    const created = await data<CreatedWebhookEndpoint>(await create(user.jwt, { description: 'agent' }), 201);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(created.secretPrefix).toBe(created.secret.slice(0, 10));
    const listed = await data<WebhookEndpoint[]>(await request('/api/webhooks', { headers: auth(user.jwt) }));
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('secret');
    const key = await user.key(['webhook.write']);
    expect((await data<WebhookEndpoint[]>(await request('/v1/webhooks', { headers: auth(key) }))).map((item) => item.id)).toEqual([created.id]);
    expect((await request('/v1/webhooks', { headers: auth(await user.key(['mail.read'])) })).status).toBe(403);
    for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://hooks.hpc.email/x', 'https://user:pw@hooks.example.com/x']) {
      expect((await create(user.jwt, { url })).status, url).toBe(400);
    }
    const rotated = await data<CreatedWebhookEndpoint>(await request(`/v1/webhooks/${created.id}/rotate-secret`, { method: 'POST', headers: auth(key) }));
    expect(rotated.secret).not.toBe(created.secret);
    const updated = await data<WebhookEndpoint>(await request(`/api/webhooks/${created.id}`, json(user.jwt, { enabled: false, events: ['mail.sent', 'mail.failed'] }, 'PUT')));
    expect(updated).toMatchObject({ status: 'disabled', events: ['mail.sent', 'mail.failed'] });
    for (let i = 1; i < 10; i++) await data(await create(user.jwt, {}), 201);
    expect((await create(user.jwt, {})).status).toBe(403);
    expect((await request(`/api/webhooks/${created.id}`, { method: 'DELETE', headers: auth(user.jwt) })).status).toBe(200);
    expect((await request(`/api/webhooks/${created.id}`, { headers: auth(user.jwt) })).status).toBe(404);
  });

  it('他人的端点对网页会话与不限范围的 Key 都是 404，且不被改动', async () => {
    const owner = await account('owner');
    const intruder = await account('intruder');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(owner.jwt, {}), 201);
    const key = await intruder.key(['webhook.write']);
    for (const [token, prefix] of [[intruder.jwt, '/api'], [key, '/v1']] as const) {
      const base = `${prefix}/webhooks/${endpoint.id}`;
      for (const [path, init] of [
        [base, { headers: auth(token) }],
        [base, json(token, { description: 'taken' }, 'PUT')],
        [`${base}/rotate-secret`, { method: 'POST', headers: auth(token) }],
        [`${base}/test`, { method: 'POST', headers: auth(token) }],
        [`${base}/deliveries`, { headers: auth(token) }],
        [`${base}/deliveries/1/retry`, { method: 'POST', headers: auth(token) }],
        [base, { method: 'DELETE', headers: auth(token) }],
      ] as const) {
        expect((await request(path, init)).status, `${init.method ?? 'GET'} ${path}`).toBe(404);
      }
    }
    const kept = await data<WebhookEndpoint>(await request(`/api/webhooks/${endpoint.id}`, { headers: auth(owner.jwt) }));
    expect(kept).toMatchObject({ description: '', secretPrefix: endpoint.secretPrefix });
  });

  it('限定了范围的 Key 只能管理过滤条件落在范围内的端点', async () => {
    const user = await account('scoped');
    const open = await data<CreatedWebhookEndpoint>(await create(user.jwt, {}), 201);
    const key = await user.key(['webhook.write', 'mail.read'], { allowedMailboxIds: [user.box.id] });
    expect((await create(key, {}, '/v1')).status).toBe(403);
    expect((await create(key, { domains: ['hpc.email'] }, '/v1')).status).toBe(403);
    const mine = await data<CreatedWebhookEndpoint>(await create(key, { addresses: [user.box.address] }, '/v1'), 201);
    expect((await data<WebhookEndpoint[]>(await request('/v1/webhooks', { headers: auth(key) }))).map((item) => item.id)).toEqual([mine.id]);
    expect((await request(`/v1/webhooks/${open.id}`, { headers: auth(key) })).status).toBe(404);
    expect((await request(`/v1/webhooks/${mine.id}`, json(key, { addresses: [] }, 'PUT'))).status).toBe(403);
  });

  it('Key 创建或修改订阅 mail.received、或带正文的端点另需 mail.read（A5）', async () => {
    const user = await account('mail-read');
    const hookOnly = await user.key(['webhook.write']);
    expect((await create(hookOnly, {}, '/v1')).status).toBe(403);
    expect((await create(hookOnly, { events: ['mail.sent'], includeBody: true }, '/v1')).status).toBe(403);
    const sent = await data<CreatedWebhookEndpoint>(await create(hookOnly, { events: ['mail.sent', 'mail.failed'] }, '/v1'), 201);
    expect((await request(`/v1/webhooks/${sent.id}`, json(hookOnly, { events: ['mail.received'] }, 'PUT'))).status).toBe(403);
    // 网页会话建的 mail.received 端点：只有 webhook.write 的 Key 改它（如换 url）同样要 mail.read
    const received = await data<CreatedWebhookEndpoint>(await create(user.jwt, {}), 201);
    expect((await request(`/v1/webhooks/${received.id}`, json(hookOnly, { url: 'https://evil.example.com/x' }, 'PUT'))).status).toBe(403);
    const kept = await data<WebhookEndpoint>(await request(`/api/webhooks/${received.id}`, { headers: auth(user.jwt) }));
    expect(kept.url).toBe('https://hooks.example.com/hpc');
    const reader = await user.key(['webhook.write', 'mail.read']);
    await data(await create(reader, { url: 'https://reader.example.com/x' }, '/v1'), 201);
    await data(await request(`/v1/webhooks/${sent.id}`, json(reader, { events: ['mail.received'] }, 'PUT')));
  });

  it('端点能收到的来信按写入它的凭据的有效角色：没有 admin scope 的管理员 Key 写的端点不收未认领地址（A27）', async () => {
    const admin = await account('admin-role');
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, admin.id));
    const plainKey = await admin.key(['webhook.write', 'mail.read']);
    const viaKey = await data<CreatedWebhookEndpoint>(await create(plainKey, { url: 'https://key.example.com/x' }, '/v1'), 201);
    const viaSession = await data<CreatedWebhookEndpoint>(await create(admin.jwt, { url: 'https://session.example.com/x' }), 201);
    const moved = await data<CreatedWebhookEndpoint>(await create(admin.jwt, { url: 'https://moved.example.com/x' }), 201);
    // 没有 admin scope 的 Key 改过的端点同样降为只收自己认领的地址
    await data(await request(`/v1/webhooks/${moved.id}`, json(plainKey, { description: 'by key' }, 'PUT')));
    const hits = receiver();
    await receive(`wh-unclaimed-${seq}@hpc.email`, 'unclaimed mail');
    expect(hits.map((hit) => new URL(hit.url).host)).toEqual(['session.example.com']);
    hits.length = 0;
    await receive(admin.box.address, 'own mail');
    expect(hits.map((hit) => new URL(hit.url).host).sort()).toEqual(['key.example.com', 'moved.example.com', 'session.example.com']);
    expect(viaKey.id).not.toBe(viaSession.id);
  });

  it('测试发送同步返回接收端结果，不写投递记录', async () => {
    const user = await account('test');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(user.jwt, {}), 201);
    const hits = receiver(() => (hits.length > 1 ? 500 : 202));
    const first = await data<WebhookTestResult>(await request(`/api/webhooks/${endpoint.id}/test`, { method: 'POST', headers: auth(user.jwt) }));
    expect(first).toMatchObject({ ok: true, httpStatus: 202 });
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ type: 'webhook.test' });
    expect(await verify(endpoint.secret, hits[0]!)).toBe(true);
    const second = await data<WebhookTestResult>(await request(`/api/webhooks/${endpoint.id}/test`, { method: 'POST', headers: auth(user.jwt) }));
    expect(second).toMatchObject({ ok: false, httpStatus: 500 });
    expect((await data<Page<WebhookDelivery>>(await request(`/api/webhooks/${endpoint.id}/deliveries`, { headers: auth(user.jwt) }))).items).toEqual([]);
  });
});

describe('Webhook v2 事件投递', () => {
  it('mail.received 带收件人、附件摘要与 Svix 签名，按地址过滤；要求时带正文', async () => {
    const user = await account('received');
    const other = (await db.insert(mailboxes).values({ address: `wh-other-${seq}@hpc.email`, domain: 'hpc.email', userId: user.id }).returning().get())!;
    const plain = await data<CreatedWebhookEndpoint>(await create(user.jwt, { addresses: [user.box.address] }), 201);
    const withBody = await data<CreatedWebhookEndpoint>(await create(user.jwt, { url: 'https://body.example.com/hpc', domains: ['hpc.email'], includeBody: true }), 201);
    const hits = receiver();
    await receive(user.box.address, 'hello webhook');
    const plainHit = hits.find((hit) => hit.url.startsWith('https://hooks.example.com'))!;
    const bodyHit = hits.find((hit) => hit.url.startsWith('https://body.example.com'))!;
    expect(await verify(plain.secret, plainHit)).toBe(true);
    expect(await verify(withBody.secret, bodyHit)).toBe(true);
    expect(plainHit.headers.get('webhook-id')).toBe(bodyHit.headers.get('webhook-id'));
    const event = JSON.parse(plainHit.body) as { id: string; type: string; data: { message: Record<string, unknown> } };
    expect(event).toMatchObject({ id: plainHit.headers.get('webhook-id'), type: 'mail.received' });
    expect(event.data.message).toMatchObject({ address: user.box.address, subject: 'hello webhook', verificationCode: '482913',
      recipients: { to: [user.box.address], cc: ['cc@example.net'] }, attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', inline: false }] });
    expect(event.data.message).not.toHaveProperty('text');
    expect((JSON.parse(bodyHit.body) as typeof event).data.message.text).toContain('482913');

    hits.length = 0;
    await receive(other.address, 'other address');
    expect(hits.map((hit) => new URL(hit.url).host)).toEqual(['body.example.com']);
  });

  it('失败按退避重试，第 8 次仍失败且期间没有成功就自动停用端点；手动重试只发一次', async () => {
    const user = await account('retry');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(user.jwt, {}), 201);
    const hits = receiver(() => 503);
    await receive(user.box.address, 'will fail');
    expect(hits).toHaveLength(1);
    const pending = (await data<Page<WebhookDelivery>>(await request(`/api/webhooks/${endpoint.id}/deliveries`, { headers: auth(user.jwt) }))).items[0]!;
    expect(pending).toMatchObject({ status: 'pending', attempts: 1, lastHttpStatus: 503 });
    expect(Date.parse(pending.nextAttemptAt!) - Date.now()).toBeGreaterThan(30_000);
    for (let attempt = 2; attempt <= 8; attempt++) {
      await env.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?').bind(pending.id).run();
      await processWebhookDeliveries(env, { ids: [pending.id] });
    }
    expect(hits).toHaveLength(8);
    expect(new Set(hits.map((hit) => hit.headers.get('webhook-id'))).size).toBe(1);
    const failed = (await data<Page<WebhookDelivery>>(await request(`/api/webhooks/${endpoint.id}/deliveries`, { headers: auth(user.jwt) }))).items[0]!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 8 });
    const disabled = await data<WebhookEndpoint>(await request(`/api/webhooks/${endpoint.id}`, { headers: auth(user.jwt) }));
    expect(disabled.status).toBe('disabled');
    expect(disabled.disabledReason).toContain('自动停用');

    expect((await request(`/api/webhooks/${endpoint.id}/deliveries/${pending.id}/retry`, { method: 'POST', headers: auth(user.jwt) })).status).toBe(409);
    await data(await request(`/api/webhooks/${endpoint.id}`, json(user.jwt, { enabled: true }, 'PUT')));
    vi.unstubAllGlobals();
    const ok = receiver(() => 200);
    await data<WebhookDelivery>(await request(`/api/webhooks/${endpoint.id}/deliveries/${pending.id}/retry`, { method: 'POST', headers: auth(user.jwt) }));
    expect(ok).toHaveLength(1);
    const after = await data<WebhookEndpoint>(await request(`/api/webhooks/${endpoint.id}`, { headers: auth(user.jwt) }));
    expect(after).toMatchObject({ status: 'active', consecutiveFailures: 0 });
  });

  it('所属用户停用后不再生成新投递，待重试的投递也不再外发（A3）', async () => {
    const user = await account('disabled');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(user.jwt, { includeBody: true }), 201);
    const hits = receiver(() => 503);
    await receive(user.box.address, 'before disable');
    expect(hits).toHaveLength(1);
    const pending = (await data<Page<WebhookDelivery>>(await request(`/api/webhooks/${endpoint.id}/deliveries`, { headers: auth(user.jwt) }))).items[0]!;
    expect(pending.status).toBe('pending');
    await env.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
    await receive(user.box.address, 'after disable');
    const count = await env.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE endpoint_id = ?').bind(endpoint.id).first<{ n: number }>();
    expect(count!.n).toBe(1);
    await env.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?').bind(pending.id).run();
    await processWebhookDeliveries(env, { ids: [pending.id] });
    expect(hits).toHaveLength(1);
    const row = await env.db.prepare('SELECT status, last_error FROM webhook_deliveries WHERE id = ?').bind(pending.id).first<{ status: string; last_error: string }>();
    expect(row).toMatchObject({ status: 'failed', last_error: expect.stringContaining('停用') });
  });

  it('永久删除邮件时作废它的投递载荷，不再自动或手动重发；回收站里的邮件也不能手动重发（A4）', async () => {
    const user = await account('purge');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(user.jwt, { includeBody: true }), 201);
    const hits = receiver(() => 503);
    await receive(user.box.address, 'to purge');
    await receive(user.box.address, 'to trash');
    expect(hits).toHaveLength(2);
    const deliveries = (await data<Page<WebhookDelivery>>(await request(`/api/webhooks/${endpoint.id}/deliveries`, { headers: auth(user.jwt) }))).items;
    const ids = await env.db.prepare(`SELECT id, CAST(substr(event_key, 15) AS INTEGER) AS message_id, payload FROM webhook_deliveries
      WHERE endpoint_id = ? ORDER BY id`).bind(endpoint.id).all<{ id: number; message_id: number; payload: string }>();
    expect(ids.results.every((row) => row.payload.includes('482913'))).toBe(true);
    const [purged, trashed] = ids.results;
    // 第二封失败用尽后进回收站：仍保留载荷，但不能手动重发
    await env.db.prepare("UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?").bind(trashed!.id).run();
    await data(await request('/api/messages/delete', json(user.jwt, { ids: [purged!.message_id, trashed!.message_id] })));
    expect((await request(`/api/webhooks/${endpoint.id}/deliveries/${trashed!.id}/retry`, { method: 'POST', headers: auth(user.jwt) })).status).toBe(409);
    await data(await request('/api/messages/purge', json(user.jwt, { ids: [purged!.message_id] })));
    const row = await env.db.prepare('SELECT status, payload, last_error FROM webhook_deliveries WHERE id = ?').bind(purged!.id)
      .first<{ status: string; payload: string; last_error: string }>();
    expect(row).toMatchObject({ status: 'failed', payload: '', last_error: expect.stringContaining('永久删除') });
    await env.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?').bind(purged!.id).run();
    await processWebhookDeliveries(env, { ids: [purged!.id] });
    vi.unstubAllGlobals();
    const later = receiver(() => 200);
    expect((await request(`/api/webhooks/${endpoint.id}/deliveries/${purged!.id}/retry`, { method: 'POST', headers: auth(user.jwt) })).status).toBe(409);
    expect(later).toHaveLength(0);
    expect(deliveries).toHaveLength(2);
  });

  it('改端点的 url 或 events 时作废未完成与失败的投递，已入队的邮件内容不会发往新地址（A5）', async () => {
    const user = await account('repoint');
    const endpoint = await data<CreatedWebhookEndpoint>(await create(user.jwt, { includeBody: true }), 201);
    const hits = receiver(() => 503);
    await receive(user.box.address, 'queued code');
    await receive(user.box.address, 'failed code');
    const rows = (await env.db.prepare('SELECT id FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id').bind(endpoint.id).all<{ id: number }>()).results;
    const [pending, failed] = rows.map((row) => Number(row.id));
    await env.db.prepare("UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?").bind(failed).run();
    // 只改描述、或原样提交同样的 url 与 events，不作废
    await data(await request(`/api/webhooks/${endpoint.id}`, json(user.jwt, { description: 'same', url: 'https://hooks.example.com/hpc', events: ['mail.received'] }, 'PUT')));
    expect((await env.db.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').bind(pending).first<{ status: string }>())!.status).toBe('pending');
    // 只有 webhook.write 的 Key 把端点改成不订阅收信、指向别处：修改后的状态不需要 mail.read，但积压的投递随之作废
    const key = await user.key(['webhook.write']);
    await data(await request(`/v1/webhooks/${endpoint.id}`, json(key, { url: 'https://attacker.example.com/h', events: ['mail.sent'], includeBody: false }, 'PUT')));
    vi.unstubAllGlobals();
    const after = receiver(() => 200);
    await env.db.prepare('UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE endpoint_id = ?').bind(endpoint.id).run();
    await processWebhookDeliveries(env, { ids: [pending!, failed!] });
    expect(after).toHaveLength(0);
    for (const id of [pending, failed]) {
      const row = await env.db.prepare('SELECT status, payload FROM webhook_deliveries WHERE id = ?').bind(id).first<{ status: string; payload: string }>();
      expect(row).toMatchObject({ status: 'failed', payload: '' });
      expect((await request(`/v1/webhooks/${endpoint.id}/deliveries/${id}/retry`, { method: 'POST', headers: auth(key) })).status).toBe(409);
    }
    expect(after).toHaveLength(0);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('发信成功与失败分别发 mail.sent / mail.failed，同一封只发一次', async () => {
    const user = await account('sent');
    await data(await create(user.jwt, { events: ['mail.sent', 'mail.failed'] }), 201);
    const hits = receiver();
    const key = await user.key(['mail.send']);
    const send = () => request('/v1/messages', { ...json(key, { from: user.box.address, to: [user.box.address], subject: 'self', text: 'hi' }),
      headers: { ...auth(key), 'Content-Type': 'application/json', 'Idempotency-Key': `wh-sent-${seq}` } });
    const sent = await data<{ id: number }>(await send(), 201);
    await send();
    const events = hits.map((hit) => JSON.parse(hit.body) as { type: string; data: { message: { id: number; status: string } } });
    expect(events.filter((event) => event.type === 'mail.sent').map((event) => event.data.message.id)).toEqual([sent.id]);
    expect(events[0]!.data.message.status).toBe('delivered');
  });

  it('托管域名的可收信、发信就绪、迁走事件按 domains 过滤投递', async () => {
    const user = await account('hosted');
    await data(await create(user.jwt, { events: ['hosted_domain.activated', 'hosted_domain.sending_ready', 'hosted_domain.moved'], domains: ['mine.example'] }), 201);
    await data(await create(user.jwt, { url: 'https://addr.example.com/x', events: ['hosted_domain.moved'], addresses: [user.box.address] }), 201);
    const before = { id: 7, userId: user.id, domain: 'mine.example', status: 'provisioning', routingStatus: '', catchAllReady: false, sendingStatus: '', checkedAt: new Date(1000) };
    await emitHostedDomainTransitions(env, before, { status: 'active', zoneStatus: 'active', routingStatus: 'ready', catchAllReady: true, sendingStatus: 'ready' });
    await emitHostedDomainTransitions(env, before, { status: 'active', zoneStatus: 'active', routingStatus: 'ready', catchAllReady: true, sendingStatus: 'ready' });
    await emitHostedDomainTransitions(env, { ...before, status: 'active', routingStatus: 'ready', catchAllReady: true, sendingStatus: 'ready', checkedAt: new Date(2000) },
      { status: 'moved', zoneStatus: 'moved' });
    const hits = receiver();
    await processWebhookDeliveries(env, { limit: 50 });
    expect(hits.map((hit) => (JSON.parse(hit.body) as { type: string }).type).sort())
      .toEqual(['hosted_domain.activated', 'hosted_domain.moved', 'hosted_domain.sending_ready']);
    expect(hits.every((hit) => hit.url.startsWith('https://hooks.example.com'))).toBe(true);
  });
});

describe('旧版通用 Webhook', () => {
  it('过渡期同时带 X-HPC-Signature 与 Svix 签名头', async () => {
    const hits = receiver();
    await sendNotifyWebhook({ enabled: true, url: 'https://legacy.example.com/hook', secret: 'legacy-secret' }, { event: 'mail.received',
      message: { id: 9, address: 'a@hpc.email', fromAddress: 'b@example.net', fromName: '', subject: 's', verificationCode: '', verificationLink: '', preview: '', createdAt: new Date().toISOString() } });
    const hit = hits[0]!;
    expect(hit.headers.get('X-HPC-Signature')).toBe(await hmacSha256Base64(new TextEncoder().encode('legacy-secret'), hit.body));
    expect(hit.headers.get('webhook-id')).toBe('msg_9');
    expect(await verify('legacy-secret', hit)).toBe(true);
  });
});
