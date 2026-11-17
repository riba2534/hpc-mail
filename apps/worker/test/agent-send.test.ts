import { OUTBOUND_DELIVERY_CONCURRENCY, OUTBOUND_PENDING_STALE_MS, type CreatedApiKey,
  type MessageSummary, type SingleUploadResult } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, draftAttachments, idempotencyRecords, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { STALE_OUTBOUND_SQL, markStaleOutbound } from '../src/services/outbound-recovery.js';
import { injectAttachmentLinks, stripAttachmentLinks } from '../src/services/attachment-links.js';
import { getMessageDetail, getThread, purgeMessages } from '../src/services/message.js';
import { sendMail } from '../src/services/outbound.js';
import { runDraftAttachmentCleanup, runScheduled } from '../src/services/scheduled.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';
import { consumeDraftAttachments, draftKey } from '../src/services/upload.js';
import type { Env } from '../src/types.js';
import { grantLegacyAdminScope, TEST_PASSWORD, testPasswordHash, USER_SCOPES } from './key-helpers.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const app = createApp();
const db = createDb(env);

interface Captured { to: string; raw: string; mail: Awaited<ReturnType<typeof PostalMime.parse>> }

/** 外发走 mock 的 send_email，postal-mime 解析捕获的原文；fail 返回错误文案时该目标被拒收 */
function mailEnv(fail: (to: string) => string | null = () => null) {
  const captured: Captured[] = [];
  const send = vi.fn(async (mail: { to: string; raw: string }) => {
    const reason = fail(mail.to);
    if (reason) throw new Error(reason);
    const raw = await new Response(mail.raw).text();
    captured.push({ to: mail.to, raw, mail: await PostalMime.parse(raw) });
  });
  return { runtime: { ...env, email: { send } } as unknown as Env, captured, send };
}

async function call(runtime: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function data<T>(response: Response, status = 201): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

async function failure(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string; fix?: string; docs?: string; details?: any } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function account(name: string, role: 'admin' | 'user' = 'user', quota = { dailyOutbound: 0, dailyRecipients: 0 }) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'another.test', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota,
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username: name, role, passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await call(env, '/api/api-keys', json(jwt, { name: `${name}-key`, scopes: USER_SCOPES, rateLimit: 600, password: TEST_PASSWORD })));
  // 管理员沿用存量 Key 的形态（迁移 0022 自动加上 admin scope）
  if (role === 'admin') await grantLegacyAdminScope(env, key.id);
  return { id: user!.id, jwt, key: key.key, address: `${name}@hpc.email`, sender: { userId: user!.id, role } };
}

async function upload(runtime: Env, key: string, filename: string, body: Uint8Array) {
  return data<SingleUploadResult>(await call(runtime, `/v1/uploads?filename=${filename}&mimeType=application%2Fpdf`, {
    method: 'POST', headers: { ...auth(key), 'Content-Length': String(body.byteLength) }, body,
  }));
}

const b64 = (text: string) => btoa(text);
const rowsBySubject = (subject: string) => db.select().from(messages).where(eq(messages.subject, subject)).orderBy(messages.id).all();

describe('A2/A4/A5 完整发信格式', () => {
  it('显示名、Reply-To、X-*、List-Unsubscribe、非 ASCII 头与名称写进外发 MIME', async () => {
    const owner = await account('fmt-owner');
    const { runtime, captured } = mailEnv();
    const sent = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, {
      from: `"Agent \\"Bot\\"" <${owner.address}>`,
      to: ['Doe, John <john@example.net>', { address: 'li@example.net', name: '李雷' }],
      cc: ['plain@example.net'],
      replyTo: ['Support Team <help@example.net>', 'second@example.net'],
      headers: {
        'x-campaign': 'spring-2026', 'X-Note': '中文备注', Comments: '评论 ok',
        'List-Unsubscribe': '<https://example.net/u/1>, <mailto:u@example.net>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      subject: 'format check', text: 'hello',
    })));
    expect(sent.status).toBe('sent');
    expect(captured).toHaveLength(3);
    const { mail, raw } = captured[0]!;
    const header = raw.split('\r\n\r\n')[0]!;
    expect(mail.from).toEqual({ address: owner.address, name: 'Agent "Bot"' });
    expect(mail.to).toEqual([{ address: 'john@example.net', name: 'Doe, John' }, { address: 'li@example.net', name: '李雷' }]);
    expect(header).toContain('To: "Doe, John" <john@example.net>');
    expect(mail.cc).toEqual([{ address: 'plain@example.net', name: '' }]);
    expect(mail.replyTo).toEqual([{ address: 'help@example.net', name: 'Support Team' }, { address: 'second@example.net', name: '' }]);
    const headers = new Map(mail.headers.map((item) => [item.key, item.value]));
    expect(headers.get('x-campaign')).toBe('spring-2026');
    expect(header).toMatch(/^X-Note: =\?utf-8\?B\?/m);
    expect(header).toMatch(/^Comments: =\?utf-8\?B\?/m);
    expect(headers.get('list-unsubscribe')).toBe('<https://example.net/u/1>, <mailto:u@example.net>');
    expect(headers.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    expect(Math.max(...header.split('\r\n').map(line => new TextEncoder().encode(line).length))).toBeLessThanOrEqual(998);
    // 非 ASCII 头取值解码后不变（postal-mime 对 X- 头保留原文，按 RFC 2047 自行解码核对）
    const decodeWords = (value: string) => value.replace(/=\?utf-8\?B\?([^?]+)\?=\s*/gi, (_word, encoded: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
    expect(decodeWords(headers.get('x-note')!)).toBe('中文备注');
    expect(decodeWords(headers.get('comments')!)).toBe('评论 ok');
    const [row] = await db.select().from(messages).where(eq(messages.id, sent.id)).all();
    expect(row!.replyTo).toEqual(['help@example.net', 'second@example.net']);
    expect(row!.recipients.to).toEqual(['john@example.net', 'li@example.net']);
    expect(row!.fromName).toBe('Agent "Bot"');
  });

  it('headers 的 In-Reply-To/References 写进发件行与站内副本，回复站外邮件能连成线程', async () => {
    const owner = await account('thread-owner');
    const peer = await account('thread-peer');
    const [original] = await db.insert(messages).values({ direction: 'inbound', address: owner.address, domain: 'hpc.email',
      status: 'received', subject: 'Question', fromAddress: 'ext@example.net', messageId: '<ext-q@example.net>' }).returning();
    const { runtime, captured } = mailEnv();
    const sent = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['ext@example.net'], cc: [peer.address], subject: 'Re: Question', text: 'answer',
      headers: { 'In-Reply-To': '<ext-q@example.net>', References: '<root@example.net> <ext-q@example.net>' },
    })));
    expect(captured[0]!.mail.inReplyTo).toBe('<ext-q@example.net>');
    expect(captured[0]!.mail.references).toBe('<root@example.net> <ext-q@example.net>');
    const rows = await rowsBySubject('Re: Question');
    expect(rows.map(row => [row.direction, row.inReplyTo, row.references])).toEqual([
      ['outbound', '<ext-q@example.net>', '<root@example.net> <ext-q@example.net>'],
      ['inbound', '<ext-q@example.net>', '<root@example.net> <ext-q@example.net>'],
    ]);
    const thread = await getThread(env, owner.sender, sent.id);
    expect(thread.map(item => item.id)).toEqual([original!.id, sent.id]);
  });

  it('内联图生成 multipart/related，站内副本保留 content_id/disposition 并在详情换成图片', async () => {
    const owner = await account('inline-owner');
    const peer = await account('inline-peer');
    const { runtime, captured } = mailEnv();
    const token = await upload(runtime, owner.key, 'chart.png', new TextEncoder().encode('png-bytes-token'));
    await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['viewer@example.net', peer.address], subject: 'inline images',
      html: '<p>logo</p><img src="cid:logo"><img src="cid:chart">',
      attachments: [{ filename: 'logo.png', contentType: 'image/png', content: b64('png-bytes-logo'), contentId: 'logo' }],
      attachmentTokens: [{ token: token.token, contentId: 'chart', disposition: 'inline' }],
    })));
    const { mail, raw } = captured[0]!;
    expect(raw).toContain('multipart/related');
    expect(mail.attachments.map(att => [att.contentId, att.disposition])).toEqual([['<logo>', 'inline'], ['<chart>', 'inline']]);
    expect(new TextDecoder().decode(mail.attachments[1]!.content as ArrayBuffer)).toBe('png-bytes-token');
    const copy = (await rowsBySubject('inline images')).find(row => row.direction === 'inbound')!;
    const rows = await db.select().from(attachments).where(eq(attachments.messageId, copy.id)).orderBy(attachments.id).all();
    expect(rows.map(row => [row.contentId, row.disposition])).toEqual([['logo', 'inline'], ['chart', 'inline']]);
    const detail = await getMessageDetail(env, peer.sender, copy.id);
    expect(detail.bodyHtml).not.toContain('cid:');
    expect(detail.bodyHtml).toContain('/api/attachments/');
  });

  it('旧写法（字符串地址、字符串 token）照常发送', async () => {
    const owner = await account('legacy-owner');
    const { runtime, captured } = mailEnv();
    const token = await upload(runtime, owner.key, 'legacy.pdf', new TextEncoder().encode('legacy pdf'));
    const sent = await data<MessageSummary>(await call(runtime, '/api/messages/send', json(owner.jwt, {
      from: { localPart: 'legacy-owner', domain: 'hpc.email' }, to: ['legacy@example.net'], cc: [], bcc: [],
      subject: 'legacy shape', text: 'body', attachmentTokens: [token.token],
    })));
    expect(sent).toMatchObject({ status: 'sent', hasAttachments: true });
    expect(captured[0]!.mail.to).toEqual([{ address: 'legacy@example.net', name: '' }]);
    expect(captured[0]!.mail.attachments.map(att => [att.filename, att.disposition])).toEqual([['legacy.pdf', 'attachment']]);
  });

  it('无权发件地址 403 带 fix 与 docs；请求体 Content-Length 超限在解析前 413', async () => {
    const owner = await account('forbid-owner');
    const error = await failure(await call(env, '/v1/messages', json(owner.key, {
      from: 'someone-else@hpc.email', to: ['x@example.net'], subject: 'nope', text: 'body',
    })), 403);
    expect(error.code).toBe('forbidden');
    expect(error.fix).toContain('/v1/identities');
    expect(error.docs).toBe('http://localhost/references/errors.md#forbidden-sender');
    const tooLarge = await failure(await call(env, '/v1/messages', {
      method: 'POST', headers: { ...auth(owner.key), 'Content-Type': 'application/json', 'Content-Length': String(16 * 1024 * 1024 + 1) },
      body: '{}',
    }), 413);
    expect(tooLarge.code).toBe('payload_too_large');
    expect(tooLarge.fix).toContain('/v1/uploads');
  });
});

describe('R39 大附件：引用草稿对象，按需读取', () => {
  it('token 附件不复制对象、站内投递不读字节；全部删除后对象最终回收', async () => {
    const owner = await account('ref-owner');
    const peer = await account('ref-peer');
    const reads: string[] = [];
    const { runtime } = mailEnv();
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'get') return (key: string, ...rest: unknown[]) => { reads.push(key); return (target.get as any)(key, ...rest); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const counted = { ...runtime, r2 } as Env;
    const token = await upload(counted, owner.key, 'report.pdf', new TextEncoder().encode('large report'));
    const key = draftKey(owner.id, token.token);
    const sent = await data<MessageSummary>(await call(counted, '/v1/messages', json(owner.key, {
      from: owner.address, to: [peer.address], subject: 'by reference', text: 'see attachment', attachmentTokens: [token.token],
    })));
    expect(sent.status).toBe('delivered');
    expect(reads).not.toContain(key);
    const rows = await rowsBySubject('by reference');
    const refs = await db.select().from(attachments).where(eq(attachments.r2Key, key)).all();
    expect(refs.map(ref => ref.messageId).sort()).toEqual(rows.map(row => row.id).sort());
    expect((await env.r2.list({ prefix: `att/${sent.id}/` })).objects).toHaveLength(0);
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.token, token.token)).get()).toBeUndefined();

    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, sent.id));
    expect(await purgeMessages(env, owner.sender, [sent.id])).toBe(1);
    await processStorageCleanup(env);
    expect(await (await env.r2.get(key))?.text()).toBe('large report');
    const copy = rows.find(row => row.direction === 'inbound')!;
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, copy.id));
    expect(await purgeMessages(env, peer.sender, [copy.id])).toBe(1);
    await processStorageCleanup(env);
    expect(await env.r2.get(key)).toBeNull();
  });

  it('附件元数据写入失败时不登记草稿对象的清理：草稿还在、对象保留，用同一 token 重发成功', async () => {
    const owner = await account('borrow-owner');
    const { runtime, captured } = mailEnv();
    const token = await upload(runtime, owner.key, 'keep.pdf', new TextEncoder().encode('keep me'));
    const faulty = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (query.startsWith('insert into "attachments"')) throw new Error('D1 attachments unavailable');
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const body = { from: owner.address, to: ['keep@example.net'], subject: 'borrowed draft', text: 'x', attachmentTokens: [token.token] };
    expect((await failure(await call({ ...runtime, db: faulty } as Env, '/v1/messages', json(owner.key, body)), 500)).code).toBe('internal');
    await processStorageCleanup(env, 1000);
    expect(await (await env.r2.get(draftKey(owner.id, token.token)))?.text()).toBe('keep me');
    expect((await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, body)))).status).toBe('sent');
    expect(new TextDecoder().decode(captured[0]!.mail.attachments[0]!.content as ArrayBuffer)).toBe('keep me');
  });

  it('回收草稿同时登记清理：仍被附件行引用的对象保留，发送途中失去引用的对象回收', async () => {
    const owner = await account('consume-owner');
    const { runtime } = mailEnv();
    const kept = await upload(runtime, owner.key, 'kept.pdf', new TextEncoder().encode('kept'));
    const orphan = await upload(runtime, owner.key, 'orphan.pdf', new TextEncoder().encode('orphan'));
    const [message] = await db.insert(messages).values({ direction: 'outbound', address: owner.address, domain: 'hpc.email',
      status: 'sent', subject: 'consume refs' }).returning();
    await db.insert(attachments).values({ messageId: message!.id, r2Key: draftKey(owner.id, kept.token), filename: 'kept.pdf', size: 4 });
    await consumeDraftAttachments(env, owner.id, [kept.token, orphan.token]);
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, owner.id)).all()).toHaveLength(0);
    await processStorageCleanup(env, 1000);
    expect(await (await env.r2.get(draftKey(owner.id, kept.token)))?.text()).toBe('kept');
    expect(await env.r2.get(draftKey(owner.id, orphan.token))).toBeNull();
  });

  it('超过外发上限转下载链接时不读附件内容；内联进 MIME 时才读', async () => {
    const owner = await account('lazy-owner');
    const reads: string[] = [];
    const { runtime, captured } = mailEnv();
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'get') return (key: string, ...rest: unknown[]) => { reads.push(key); return (target.get as any)(key, ...rest); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const counted = { ...runtime, r2 } as Env;
    const big = await upload(counted, owner.key, 'big.bin', new Uint8Array(4 * 1024 * 1024));
    await data<MessageSummary>(await call(counted, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'big by link', text: 'big', attachmentTokens: [big.token],
    })));
    expect(reads).not.toContain(draftKey(owner.id, big.token));
    expect(captured[0]!.mail.attachments).toHaveLength(0);
    const small = await upload(counted, owner.key, 'small.bin', new TextEncoder().encode('small'));
    await data<MessageSummary>(await call(counted, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'small inline', text: 'small', attachmentTokens: [small.token],
    })));
    expect(reads.filter(key => key === draftKey(owner.id, small.token))).toHaveLength(1);
    expect(new TextDecoder().decode(captured[1]!.mail.attachments[0]!.content as ArrayBuffer)).toBe('small');
  });

  it('过期草稿与删除草稿只登记清理：被（全部失败的）发件行引用的对象保留，未引用的删除', async () => {
    const owner = await account('draft-ttl-owner');
    const { runtime } = mailEnv(() => 'mailbox unavailable');
    const kept = await upload(runtime, owner.key, 'kept.pdf', new TextEncoder().encode('kept'));
    const lone = await upload(runtime, owner.key, 'lone.pdf', new TextEncoder().encode('lone'));
    const deleted = await upload(runtime, owner.key, 'deleted.pdf', new TextEncoder().encode('deleted'));
    expect((await failure(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['gone@example.net'], subject: 'all failed keeps draft', text: 'x', attachmentTokens: [kept.token, deleted.token],
    })), 422)).code).toBe('delivery_failed');
    // 全部失败不回收草稿：同一 token 可以修正后再发
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.token, kept.token)).get()).toBeDefined();
    expect((await call(runtime, `/v1/uploads/${deleted.token}`, { method: 'DELETE', headers: auth(owner.key) })).status).toBe(200);
    await db.update(draftAttachments).set({ createdAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(draftAttachments.userId, owner.id));
    expect(await runDraftAttachmentCleanup(env)).toBeGreaterThanOrEqual(2);
    await processStorageCleanup(env, 1000);
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, owner.id)).all()).toHaveLength(0);
    expect(await (await env.r2.get(draftKey(owner.id, kept.token)))?.text()).toBe('kept');
    expect(await (await env.r2.get(draftKey(owner.id, deleted.token)))?.text()).toBe('deleted');
    expect(await env.r2.get(draftKey(owner.id, lone.token))).toBeNull();
  });
});

describe('R23/R36 外发可靠性', () => {
  it(`外部收件人最多 ${OUTBOUND_DELIVERY_CONCURRENCY} 路并发，每完成一个目标增量回填结果`, async () => {
    const owner = await account('pool-owner', 'admin');
    const gates = new Map<string, (error?: Error) => void>();
    let inflight = 0;
    let peak = 0;
    const send = vi.fn(async (mail: { to: string }) => {
      inflight++;
      peak = Math.max(peak, inflight);
      try {
        await new Promise<void>((resolve, reject) => gates.set(mail.to, (error) => (error ? reject(error) : resolve())));
      } finally { inflight--; }
    });
    const targets = Array.from({ length: 6 }, (_, i) => `pool-${i}@example.net`);
    const pending = sendMail({ ...env, email: { send } } as unknown as Env, { waitUntil: () => {} }, owner.sender, {
      from: { localPart: 'pool-owner', domain: 'hpc.email' }, to: [], cc: [], bcc: targets, subject: 'bounded pool', text: 'body',
    }, [], 'https://hpc.email');
    await vi.waitFor(() => expect(gates.size).toBe(OUTBOUND_DELIVERY_CONCURRENCY));
    expect(peak).toBe(OUTBOUND_DELIVERY_CONCURRENCY);
    gates.get(targets[1]!)!();
    gates.get(targets[0]!)!(new Error('mailbox full'));
    const [row] = await rowsBySubject('bounded pool');
    await vi.waitFor(async () => {
      const current = await db.select().from(messages).where(eq(messages.id, row!.id)).get();
      expect(current!.status).toBe('pending');
      expect(current!.recipientOutcomes).toEqual([
        { address: targets[0], status: 'failed', error: 'mailbox full' },
        { address: targets[1], status: 'sent' },
      ]);
    });
    await vi.waitFor(() => expect(gates.size).toBe(6));
    for (const target of targets.slice(2)) gates.get(target)!();
    const summary = await pending;
    expect(peak).toBe(OUTBOUND_DELIVERY_CONCURRENCY);
    expect(summary.status).toBe('sent');
    expect(summary.errorDetail).toBe(`部分收件人失败: ${targets[0]}: mailbox full`);
    expect(summary.recipientOutcomes!.map(outcome => outcome.address)).toEqual(targets);
    expect((await db.select().from(messages).where(eq(messages.id, row!.id)).get())!.recipientOutcomes).toEqual(summary.recipientOutcomes);
  });

  it('全部收件人被拒收返回 422 delivery_failed，同 Key 重放一致，并退还配额', async () => {
    const owner = await account('reject-owner', 'user', { dailyOutbound: 1, dailyRecipients: 0 });
    const { runtime } = mailEnv((to) => (to.startsWith('bad') ? `destination not verified: ${to}` : null));
    const body = { from: owner.address, to: ['bad-1@example.net', 'bad-2@example.net'], subject: 'all rejected', text: 'x' };
    const headers = { 'Idempotency-Key': 'all-rejected-key' };
    const first = await failure(await call(runtime, '/v1/messages', json(owner.key, body, headers)), 422);
    expect(first.code).toBe('delivery_failed');
    expect(first.message).toBe('全部收件人投递失败: bad-1@example.net: destination not verified: bad-1@example.net; bad-2@example.net: destination not verified: bad-2@example.net');
    expect(first.fix).toBeTruthy();
    expect(first.docs).toBe('http://localhost/references/errors.md#delivery_failed');
    expect(first.details.recipientOutcomes).toEqual([
      { address: 'bad-1@example.net', status: 'failed', error: 'destination not verified: bad-1@example.net' },
      { address: 'bad-2@example.net', status: 'failed', error: 'destination not verified: bad-2@example.net' },
    ]);
    const row = await db.select().from(messages).where(eq(messages.id, first.details.messageId)).get();
    expect(row).toMatchObject({ direction: 'outbound', status: 'failed', errorDetail: first.message });
    const replay = await failure(await call(runtime, '/v1/messages', json(owner.key, body, headers)), 422);
    expect(replay).toEqual(first);
    // 配额上限 1 封：全部失败退还后仍可发送
    const ok = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, { ...body, to: ['good@example.net'], subject: 'after refund' })));
    expect(ok.status).toBe('sent');
  });

  it('部分失败仍 201，errorDetail 只写部分失败', async () => {
    const owner = await account('partial-owner');
    const { runtime } = mailEnv((to) => (to === 'bad@example.net' ? 'rejected' : null));
    const sent = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['good@example.net', 'bad@example.net'], subject: 'partial', text: 'x',
    })));
    expect(sent.status).toBe('sent');
    expect(sent.errorDetail).toBe('部分收件人失败: bad@example.net: rejected');
  });

  it('处理中途服务端故障（没有尝试任何目标）返回 500，同 Key 重放为 422 且不重投', async () => {
    const owner = await account('midway-owner');
    const { runtime, send } = mailEnv();
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'put') return (key: string, ...rest: unknown[]) => {
        if (key.startsWith('att/')) throw new Error('R2 unavailable');
        return (target.put as any)(key, ...rest);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const body = { from: owner.address, to: ['x@example.net'], subject: 'midway failure', text: 'x',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: b64('a') }] };
    const headers = { 'Idempotency-Key': 'midway-key' };
    const first = await failure(await call({ ...runtime, r2 } as Env, '/v1/messages', json(owner.key, body, headers)), 500);
    expect(first.code).toBe('internal');
    expect(first.message).toContain('R2 unavailable');
    const replay = await failure(await call(runtime, '/v1/messages', json(owner.key, body, headers)), 422);
    expect(replay.code).toBe('delivery_failed');
    expect(replay.details.recipientOutcomes).toEqual([{ address: 'x@example.net', status: 'failed', error: 'R2 unavailable' }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('cron 把超时 pending 外发标为 unknown：保留已有结果、补齐缺的目标；同 Key 重放 201 unknown', async () => {
    const owner = await account('stale-owner');
    let releaseLast!: () => void;
    const lastGate = new Promise<void>((resolve) => { releaseLast = resolve; });
    const { runtime } = mailEnv();
    const send = runtime.email.send;
    // 最后一个目标卡住，前两个的结果先增量回填；最终结果回填持续失败，行停在 pending
    const slow = { ...runtime, email: { send: async (mail: { to: string }) => {
      if (mail.to === 'c@example.net') await lastGate;
      return (send as any)(mail);
    } } };
    const faulty = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        // 结果缓存也没写成（相当于请求在返回前被取消）
        if (query.startsWith('update "idempotency_records" set "status"')) throw new Error('D1 down');
        if (query.startsWith('update "messages"') && query.includes('"error_detail"') && query.includes('"recipient_outcomes"')) throw new Error('D1 down');
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const body = { from: owner.address, to: ['a@example.net', 'b@example.net'], cc: ['c@example.net'], subject: 'stale pending', text: 'x' };
    const headers = { 'Idempotency-Key': 'stale-key' };
    const pending = call({ ...slow, db: faulty } as unknown as Env, '/v1/messages', json(owner.key, body, headers));
    await vi.waitFor(async () => {
      const [row] = await rowsBySubject('stale pending');
      expect(row?.recipientOutcomes).toEqual([{ address: 'a@example.net', status: 'sent' }, { address: 'b@example.net', status: 'sent' }]);
    });
    releaseLast();
    const sent = await data<MessageSummary>(await pending);
    expect(sent.status).toBe('sent');
    expect((await failure(await call(runtime, '/v1/messages', json(owner.key, body, headers)), 409)).code).toBe('send_in_progress');
    expect((await db.select().from(messages).where(eq(messages.id, sent.id)).get())!.status).toBe('pending');
    const [fresh] = await db.insert(messages).values({ direction: 'outbound', address: owner.address, domain: 'hpc.email',
      status: 'pending', subject: 'fresh pending', recipients: { to: ['z@example.net'], cc: [], bcc: [] } }).returning();
    await db.update(messages).set({ createdAt: new Date(Date.now() - OUTBOUND_PENDING_STALE_MS - 60_000) }).where(eq(messages.id, sent.id));
    expect(await markStaleOutbound(env)).toBe(1);
    const row = await db.select().from(messages).where(eq(messages.id, sent.id)).get();
    expect(row).toMatchObject({ status: 'unknown', errorDetail: '投递中断，结果未确认: c@example.net' });
    expect(row!.recipientOutcomes).toEqual([
      { address: 'a@example.net', status: 'sent' }, { address: 'b@example.net', status: 'sent' },
      { address: 'c@example.net', status: 'unknown', error: '投递中断，结果未确认' },
    ]);
    expect((await db.select().from(messages).where(eq(messages.id, fresh!.id)).get())!.status).toBe('pending');
    const replay = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, body, headers)));
    expect(replay).toMatchObject({ id: sent.id, status: 'unknown' });
  });

  it('幂等清理把 unknown 视为终态：绑定 unknown 发件行的 pending 记录过保留期后删除', async () => {
    const owner = await account('stale-idem-owner');
    const [row] = await db.insert(messages).values({ direction: 'outbound', address: owner.address, domain: 'hpc.email',
      status: 'unknown', subject: 'unknown idem', recipients: { to: ['z@example.net'], cc: [], bcc: [] } }).returning();
    const old = new Date(Date.now() - 3 * 86400_000);
    await db.insert(idempotencyRecords).values({ actorType: 'user', actorId: owner.id, key: 'unknown-idem', requestHash: 'h',
      status: 'pending', messageId: row!.id, updatedAt: old, createdAt: old });
    await runScheduled(env, true);
    expect(await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, 'unknown-idem')).get()).toBeUndefined();
  });

  it('cron 查询走 idx_messages_outbound_pending 部分索引', async () => {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${STALE_OUTBOUND_SQL}`).bind(Date.now(), 100).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(' | ')).toMatch(/USING INDEX idx_messages_outbound_pending/);
  });
});

describe('X05/R37 附件下载区块', () => {
  it('大附件邮件补发与重发正文只有一段附件下载区块（新写法）', async () => {
    const owner = await account('x05-owner');
    const { runtime, captured } = mailEnv();
    const base = { from: owner.address, to: ['first@example.net'], subject: 'x05 large', text: 'Hello text', html: '<p>Hello html</p>',
      attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', content: btoa('\0'.repeat(4 * 1024 * 1024)) }] };
    const original = await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, base)));
    const detail = await getMessageDetail(env, owner.sender, original.id);
    expect(detail.bodyText.match(/附件下载/g)).toHaveLength(1);
    expect(detail.bodyHtml).toContain('<!--hpc-mail:attachment-links-->');
    await data<MessageSummary>(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['retry@example.net'], subject: 'x05 large', text: detail.bodyText, html: detail.bodyHtml,
      forwardAttachmentsFrom: original.id,
    })));
    const resent = captured[1]!.mail;
    expect(resent.text!.match(/附件下载/g)).toHaveLength(1);
    expect(resent.html!.match(/附件下载/g)).toHaveLength(1);
    expect(resent.text!.startsWith('Hello text\n\n— 附件下载')).toBe(true);
    expect(resent.html!.startsWith('<p>Hello html</p><!--hpc-mail:attachment-links-->')).toBe(true);
    expect(resent.html).not.toContain(detail.bodyHtml.slice(detail.bodyHtml.indexOf('href="'), detail.bodyHtml.indexOf('">big.bin')));
  });

  it('剔除上线前的旧写法区块；其他邮件、其他站点的链接与用户内容原样保留', () => {
    const origin = 'https://hpc.email';
    const link = (id: number, host = origin) => `${host}/api/attachments/${id}?exp=1&sig=abc`;
    const legacyHtml = `<p>Body</p><br><p>— 附件下载（<em>链接有效期 90 天</em>）—</p><ul><li><a href="${link(7)}">a &amp; b.pdf</a> (4.0 MB)</li><li><a href="${link(8)}">c.pdf</a> (12 KB)</li></ul>`;
    const legacyText = `Body\n\n— 附件下载（链接有效期 90 天）—\n· a (b).pdf (4.0 MB): ${link(7)}\n· c.pdf (12 KB): ${link(8)}\nPS kept`;
    expect(stripAttachmentLinks(legacyText, legacyHtml, origin, new Set([7, 8]))).toEqual({ text: 'Body\nPS kept', html: '<p>Body</p>' });
    // 只带回了其中一个附件、或链接来自其他站点：不是这次重新带上的附件，保留
    expect(stripAttachmentLinks(legacyText, legacyHtml, origin, new Set([7]))).toEqual({ text: legacyText, html: legacyHtml });
    const foreign = legacyHtml.replaceAll(origin, 'https://other.example');
    expect(stripAttachmentLinks('', foreign, origin, new Set([7, 8])).html).toBe(foreign);
    const injected = injectAttachmentLinks('Body', '<p>Body</p>', [{ filename: 'x\r\ny.pdf', size: 10, url: link(9) }]);
    expect(injected.text).toBe(`Body\n\n— 附件下载（链接有效期 90 天）—\n· x y.pdf (10 B): ${link(9)}`);
    expect(stripAttachmentLinks(injected.text, injected.html, origin, new Set([9]))).toEqual({ text: 'Body', html: '<p>Body</p>' });
    const userWritten = '<p>— 附件下载（<em>链接有效期 90 天</em>）—</p><p>我自己写的说明</p>';
    expect(stripAttachmentLinks('', userWritten, origin, new Set([9])).html).toBe(userWritten);
  });

  it('补发上线前旧写法的大邮件时不重复区块', async () => {
    const owner = await account('x05-legacy');
    const { runtime, captured } = mailEnv();
    const [source] = await db.insert(messages).values({ direction: 'outbound', address: owner.address, domain: 'hpc.email',
      status: 'sent', subject: 'legacy large', recipients: { to: ['first@example.net'], cc: [], bcc: [] } }).returning();
    await env.r2.put('att/x05-legacy/big.bin', new Uint8Array(4 * 1024 * 1024));
    const [att] = await db.insert(attachments).values({ messageId: source!.id, r2Key: 'att/x05-legacy/big.bin', filename: 'big.bin',
      mimeType: 'application/octet-stream', size: 4 * 1024 * 1024 }).returning();
    const url = `https://hpc.email/api/attachments/${att!.id}?exp=1&sig=old`;
    const html = `<p>Old</p><br><p>— 附件下载（<em>链接有效期 90 天</em>）—</p><ul><li><a href="${url}">big.bin</a> (4.0 MB)</li></ul>`;
    await data<MessageSummary>(await call({ ...runtime, site_origin: 'https://hpc.email' } as Env, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['retry@example.net'], subject: 'legacy large', html, forwardAttachmentsFrom: source!.id,
    })));
    expect(captured[0]!.mail.html!.match(/附件下载/g)).toHaveLength(1);
    expect(captured[0]!.mail.html).not.toContain('sig=old');
  });

  it('img1 与 img10 的 CID 各自替换，互不影响', () => {
    const out = injectAttachmentLinks('', '<img src="cid:img1"><img src="cid:img10">', [
      { filename: '1.png', size: 1, url: 'https://hpc.email/api/attachments/1?s=1', contentId: 'img1' },
      { filename: '10.png', size: 1, url: 'https://hpc.email/api/attachments/10?s=10', contentId: 'img10' },
    ]);
    expect(out.html.startsWith('<img src="https://hpc.email/api/attachments/1?s=1"><img src="https://hpc.email/api/attachments/10?s=10">')).toBe(true);
  });
});

describe('站内转发按需读取附件', () => {
  it('没有归属人开启转发时，站内副本不读附件字节', async () => {
    const owner = await account('fwd-lazy-owner');
    const peer = await account('fwd-lazy-peer');
    const reads: string[] = [];
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'get') return (key: string, ...rest: unknown[]) => { reads.push(key); return (target.get as any)(key, ...rest); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { runtime } = mailEnv();
    const counted = { ...runtime, r2 } as Env;
    const token = await upload(counted, owner.key, 'inside.pdf', new TextEncoder().encode('inside'));
    await data<MessageSummary>(await call(counted, '/v1/messages', json(owner.key, {
      from: owner.address, to: [peer.address], subject: 'internal lazy', text: 'x', attachmentTokens: [token.token],
    })));
    expect(reads).not.toContain(draftKey(owner.id, token.token));
    const copy = await db.select().from(messages).where(and(eq(messages.subject, 'internal lazy'), eq(messages.direction, 'inbound'))).get();
    expect(copy?.address).toBe(peer.address);
  });
});
