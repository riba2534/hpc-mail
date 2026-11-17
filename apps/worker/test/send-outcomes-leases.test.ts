import { OUTBOUND_PENDING_STALE_MS, type CreatedApiKey, type MessageSummary, type SingleUploadResult } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import {
  attachments, deliveryObjectLeases, draftAttachments, idempotencyRecords, mailboxes, messages, users,
} from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { markStaleOutbound } from '../src/services/outbound-recovery.js';
import { finalWriteRetry, isDefiniteSendRejection, sendMail } from '../src/services/outbound.js';
import { runDraftAttachmentCleanup } from '../src/services/scheduled.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { grantLegacyAdminScope, TEST_PASSWORD, testPasswordHash, USER_SCOPES } from './key-helpers.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';
import { draftKey, resolveDraftAttachments } from '../src/services/upload.js';
import type { Env } from '../src/types.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const app = createApp();
const db = createDb(env);

interface Captured { to: string; mail: Awaited<ReturnType<typeof PostalMime.parse>> }

/** mock send_email：outcome 返回要抛的错误时该目标投递报错 */
function mailEnv(outcome: (to: string) => unknown = () => null) {
  const captured: Captured[] = [];
  const send = vi.fn(async (mail: { to: string; raw: string }) => {
    const error = outcome(mail.to);
    if (error) throw error;
    captured.push({ to: mail.to, mail: await PostalMime.parse(await new Response(mail.raw).text()) });
  });
  return { runtime: { ...env, email: { send } } as unknown as Env, captured, send };
}

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

async function call(runtime: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function body(response: Response, status: number) {
  const parsed = await response.json() as { data?: MessageSummary; error?: { code: string; message: string; details?: any } };
  expect(response.status, JSON.stringify(parsed)).toBe(status);
  return parsed;
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
  const [box] = await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const created = await body(await call(env, '/api/api-keys', json(jwt, { name: `${name}-key`, scopes: USER_SCOPES, rateLimit: 600, password: TEST_PASSWORD })), 201);
  // 管理员沿用存量 Key 的形态（迁移 0022 自动加上 admin scope）
  if (role === 'admin') await grantLegacyAdminScope(env, (created.data as unknown as CreatedApiKey).id);
  return { id: user!.id, key: (created.data as unknown as CreatedApiKey).key, address: `${name}@hpc.email`, boxId: box!.id,
    sender: { userId: user!.id, role } };
}

async function upload(runtime: Env, key: string, filename: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const response = await call(runtime, `/v1/uploads?filename=${filename}&mimeType=text%2Fplain`, {
    method: 'POST', headers: { ...auth(key), 'Content-Length': String(bytes.byteLength) }, body: bytes,
  });
  return (await body(response, 201)).data as unknown as SingleUploadResult;
}

/**
 * 在第一次写入发件行（校验与幂等占位都已完成、投递尚未开始）时先执行 hook：模拟解析之后、投递之前对象的持有方删除了它。
 * hook 用未包装的 env.db，不会再触发自己
 */
function beforeOutboundInsert(hook: () => Promise<void>) {
  let fired = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
    if (property === 'all' || property === 'raw' || property === 'first' || property === 'run') {
      return async (...args: unknown[]) => {
        if (!fired) { fired = true; await hook(); }
        return (target[property] as (...rest: unknown[]) => unknown)(...args);
      };
    }
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => {
      const statement = target.prepare(query);
      return !fired && query.startsWith('insert into "messages"') ? wrap(statement) : statement;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const leasesOf = () => db.select().from(deliveryObjectLeases).all();

/** 记录登记租约的语句（含绑定参数，供 EXPLAIN）；beforeBatch 在含这类语句的 batch 执行前运行一次 */
function leaseSpy(beforeBatch?: () => Promise<void>) {
  const leaseStatements = new WeakSet<object>();
  const recorded: { sql: string; params: unknown[] }[] = [];
  let fired = false;
  const db = new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => {
      const statement = target.prepare(query);
      if (!query.startsWith('insert into "delivery_object_leases"') || !query.includes(' select ')) return statement;
      const entry = { sql: query, params: [] as unknown[] };
      recorded.push(entry);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => { entry.params = args; const bound = bind(...args); leaseStatements.add(bound); return bound; };
      return statement;
    };
    if (property === 'batch') return async (list: D1PreparedStatement[]) => {
      if (beforeBatch && !fired && list.some((statement) => leaseStatements.has(statement))) { fired = true; await beforeBatch(); }
      return target.batch(list);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return Object.assign(db, { recorded });
}

describe('N16 send_email 报错分类', () => {
  it('只有官方错误码或明确的拒收文案算明确拒收，其余一律结果不明', () => {
    for (const code of ['E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
      'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_ACCOUNT_SUSPENDED',
      'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED', 'E_RATE_LIMIT_EXCEEDED',
      'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID',
      'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY']) {
      expect(isDefiniteSendRejection(coded(code)), code).toBe(true);
    }
    // 有错误码时只看错误码：内部错误与表外的新码即使文案像拒收也不算
    expect(isDefiniteSendRejection(coded('E_INTERNAL_SERVER_ERROR', 'Internal service error'))).toBe(false);
    expect(isDefiniteSendRejection(coded('E_SOMETHING_NEW', 'destination address not verified'))).toBe(false);
    for (const message of [
      'destination address not verified', 'destination address is not a verified address', 'Sender domain not verified',
      'invalid email address', 'Invalid sender address', 'Domain not available for sending', 'domain is not onboarded',
      'Recipient not in allowed list', 'recipient suppressed', 'Rate limit exceeded', 'Daily limit exceeded', 'sending quota exceeded',
    ]) expect(isDefiniteSendRejection(new Error(message)), message).toBe(true);
    for (const error of [
      new Error('Network connection lost.'), new Error('The operation was aborted due to timeout'), new Error('internal error'),
      new Error('mailbox unavailable'), new TypeError('fetch failed'), 'boom', null, undefined, { code: 42 },
    ]) expect(isDefiniteSendRejection(error), String(error)).toBe(false);
  });

  it('全部结果不明：201 + status unknown，errorDetail 引导先核对；不退配额；同 Key 重放完全一致', async () => {
    const owner = await account('x2-unknown', 'user', { dailyOutbound: 1, dailyRecipients: 0 });
    const { runtime } = mailEnv(() => new Error('Network connection lost.'));
    const request = { from: owner.address, to: ['maybe@example.net'], subject: 'x2 unknown', text: 'x' };
    const headers = { 'Idempotency-Key': 'x2-unknown-key' };
    const first = await body(await call(runtime, '/v1/messages', json(owner.key, request, headers)), 201);
    expect(first.data).toMatchObject({
      status: 'unknown',
      errorDetail: '投递结果未确认，可能已送达，补发前先向收件人核对: maybe@example.net: Network connection lost.',
      recipientOutcomes: [{ address: 'maybe@example.net', status: 'unknown', error: 'Network connection lost.' }],
    });
    const row = await db.select().from(messages).where(eq(messages.id, first.data!.id)).get();
    expect(row).toMatchObject({ status: 'unknown', errorDetail: first.data!.errorDetail, recipientOutcomes: first.data!.recipientOutcomes });
    const replay = await body(await call(runtime, '/v1/messages', json(owner.key, request, headers)), 201);
    expect(replay.data).toEqual(first.data);
    // 可能已经发出：配额不退，上限 1 封时下一封被拒
    expect((await body(await call(runtime, '/v1/messages', json(owner.key, { ...request, subject: 'x2 unknown 2' })), 429)).error!.code)
      .toBe('rate_limited');
  });

  it('送达、明确拒收、结果不明混合：201 sent，errorDetail 分别列出；没有送达时为 unknown 并附已失败目标', async () => {
    const owner = await account('x2-mixed');
    const { runtime } = mailEnv((to) => (to.startsWith('bad') ? coded('E_RECIPIENT_NOT_ALLOWED', 'Recipient not in allowed list')
      : to.startsWith('slow') ? new Error('The operation was aborted due to timeout') : null));
    const mixed = await body(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['good@example.net', 'bad@example.net', 'slow@example.net'], subject: 'x2 mixed', text: 'x',
    }, { 'Idempotency-Key': 'x2-mixed-key' })), 201);
    expect(mixed.data).toMatchObject({
      status: 'sent',
      errorDetail: '部分收件人失败: bad@example.net: Recipient not in allowed list；'
        + '部分收件人投递结果未确认，可能已送达，补发前先向收件人核对: slow@example.net: The operation was aborted due to timeout',
      recipientOutcomes: [
        { address: 'good@example.net', status: 'sent' },
        { address: 'bad@example.net', status: 'failed', error: 'Recipient not in allowed list' },
        { address: 'slow@example.net', status: 'unknown', error: 'The operation was aborted due to timeout' },
      ],
    });
    const none = await body(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['bad@example.net', 'slow@example.net'], subject: 'x2 none delivered', text: 'x',
    }, { 'Idempotency-Key': 'x2-none-key' })), 201);
    expect(none.data).toMatchObject({
      status: 'unknown',
      errorDetail: '投递结果未确认，可能已送达，补发前先向收件人核对: slow@example.net: The operation was aborted due to timeout'
        + '；已失败: bad@example.net: Recipient not in allowed list',
    });
    const replay = await body(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['bad@example.net', 'slow@example.net'], subject: 'x2 none delivered', text: 'x',
    }, { 'Idempotency-Key': 'x2-none-key' })), 201);
    expect(replay.data).toEqual(none.data);
  });

  it('全部明确拒收的 422 结果写进幂等记录，重放从记录取同一个结果', async () => {
    const owner = await account('x2-rejected');
    const { runtime } = mailEnv(() => coded('E_SENDER_NOT_VERIFIED', 'Sender domain not verified'));
    const request = { from: owner.address, to: ['r@example.net'], subject: 'x2 rejected', text: 'x' };
    const headers = { 'Idempotency-Key': 'x2-rejected-key' };
    const first = await body(await call(runtime, '/v1/messages', json(owner.key, request, headers)), 422);
    expect(first.error).toMatchObject({ code: 'delivery_failed', message: '全部收件人投递失败: r@example.net: Sender domain not verified' });
    const record = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, 'x2-rejected-key')).get();
    expect(record).toMatchObject({ status: 'completed', messageId: first.error!.details.messageId });
    expect(JSON.parse(record!.responseJson!)).toMatchObject({ status: 'failed', recipientOutcomes: first.error!.details.recipientOutcomes });
    // 发件行被删也不影响重放：结果取自幂等记录
    await db.delete(messages).where(eq(messages.id, first.error!.details.messageId));
    const replay = await body(await call(runtime, '/v1/messages', json(owner.key, request, headers)), 422);
    expect(replay.error).toEqual(first.error);
  });

  it('请求自带的附件并发写 R2：一个写失败时不再开始新的、不外发，写过的对象都登记清理', async () => {
    const owner = await account('x2-att-upload');
    const { runtime, send } = mailEnv();
    const attempted: string[] = [];
    const r2 = new Proxy(env.r2, {
      get(target, prop) {
        if (prop !== 'put') return Reflect.get(target, prop, target);
        return async (key: string, value: unknown, options: unknown) => {
          if (key.startsWith('att/')) {
            attempted.push(key);
            if (attempted.length === 2) throw new Error('R2 unavailable');
          }
          return target.put(key, value as ArrayBuffer, options as R2PutOptions);
        };
      },
    });
    const files = Array.from({ length: 8 }, (_, i) => ({ filename: `f${i}.txt`, contentType: 'text/plain', content: btoa(`file ${i}`) }));
    const result = await body(await call({ ...runtime, r2 } as Env, '/v1/messages',
      json(owner.key, { from: owner.address, to: ['r@example.net'], subject: 'x2 upload', text: 'x', attachments: files })), 422);
    expect(result.error!.message).toContain('R2 unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(attempted.length).toBeLessThan(files.length);
    const queued = await env.db.prepare(`SELECT r2_key FROM storage_cleanup_jobs WHERE r2_key IN (${attempted.map(() => '?').join(', ')})`)
      .bind(...attempted).all<{ r2_key: string }>();
    expect(queued.results.map((row) => row.r2_key).sort()).toEqual([...attempted].sort());
  });
});

describe('N16 中断外发的 cron 收尾', () => {
  it('增量回填里已是 unknown 的目标与没回填的目标一起列为待核对', async () => {
    const [row] = await db.insert(messages).values({ direction: 'outbound', address: 'x2-stale@hpc.email', domain: 'hpc.email',
      status: 'pending', subject: 'x2 stale unknown', recipients: { to: ['a@example.net', 'b@example.net'], cc: ['c@example.net'], bcc: [] },
      recipientOutcomes: [{ address: 'a@example.net', status: 'unknown', error: 'timeout' }, { address: 'b@example.net', status: 'failed', error: 'rejected' }],
      createdAt: new Date(Date.now() - OUTBOUND_PENDING_STALE_MS - 60_000) }).returning({ id: messages.id });
    expect(await markStaleOutbound(env)).toBe(1);
    expect(await db.select().from(messages).where(eq(messages.id, row!.id)).get()).toMatchObject({
      status: 'unknown',
      errorDetail: '投递中断，结果未确认: a@example.net, c@example.net；已失败: b@example.net: rejected',
    });
  });
});

describe('N17 最终结果回填', () => {
  it('请求内两次回填失败时交给 waitUntil 退避重试：发件行与幂等记录最终都等于已返回的结果', async () => {
    finalWriteRetry.delaysMs = [1, 1, 1];
    const delays = [1_000, 3_000, 10_000];
    onTestFinished(() => { finalWriteRetry.delaysMs = delays; });
    const owner = await account('x2-final-write');
    const { runtime } = mailEnv();
    let failures = 0;
    const flaky = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (failures < 2 && query.startsWith('update "messages"') && query.includes('"recipient_outcomes"')) {
          failures++;
          // 执行时失败（与线上 D1 报错同一时机）
          return target.prepare('SELECT * FROM injected_d1_blip');
        }
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const request = { from: owner.address, to: ['late@example.net'], subject: 'x2 final write', text: 'x' };
    const headers = { 'Idempotency-Key': 'x2-final-key' };
    const first = await body(await call({ ...runtime, db: flaky } as Env, '/v1/messages', json(owner.key, request, headers)), 201);
    expect(failures).toBe(2);
    expect(first.data!.status).toBe('sent');
    const row = await db.select().from(messages).where(eq(messages.id, first.data!.id)).get();
    expect(row).toMatchObject({ status: 'sent', recipientOutcomes: [{ address: 'late@example.net', status: 'sent' }] });
    const record = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, 'x2-final-key')).get();
    expect(record!.status).toBe('completed');
    expect(JSON.parse(record!.responseJson!)).toEqual(first.data);
    const replay = await body(await call(runtime, '/v1/messages', json(owner.key, request, headers)), 201);
    expect(replay.data).toEqual(first.data);
  });
});

describe('N15 引用对象先登记租约再校验', () => {
  it('草稿：解析时登记租约；校验之后、投递之前草稿被删除（DELETE /uploads）对象仍可用，投递后按引用回收', async () => {
    const owner = await account('x2-draft-race');
    const { runtime, captured } = mailEnv();
    const draft = await upload(runtime, owner.key, 'race.txt', 'race content');
    const key = draftKey(owner.id, draft.token);
    const hooked = beforeOutboundInsert(async () => {
      expect((await call(runtime, `/v1/uploads/${draft.token}`, { method: 'DELETE', headers: auth(owner.key) })).status).toBe(200);
      await processStorageCleanup(env, 1000);
      // 租约在：对象保留，清理台账留到租约释放后再判断
      expect(await env.r2.head(key)).not.toBeNull();
    });
    const sent = await body(await call({ ...runtime, db: hooked } as Env, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'x2 draft race', text: 'x', attachmentTokens: [draft.token],
    })), 201);
    expect(sent.data!.status).toBe('sent');
    expect(new TextDecoder().decode(captured[0]!.mail.attachments[0]!.content as ArrayBuffer)).toBe('race content');
    expect(await leasesOf()).toEqual([]);
    // 投递结束：发件行的附件行引用对象，保留；发件行永久删除后对象回收
    await processStorageCleanup(env, 1000);
    expect(await (await env.r2.get(key))?.text()).toBe('race content');
    await purgeMatchingMessages(env, eq(messages.id, sent.data!.id));
    await processStorageCleanup(env, 1000);
    expect(await env.r2.get(key)).toBeNull();
  });

  it('草稿：租约登记后草稿到期清理也不删对象；投递前失败释放租约，对象随后按引用回收', async () => {
    const owner = await account('x2-draft-expiry');
    const { runtime, captured } = mailEnv();
    const kept = await upload(runtime, owner.key, 'kept.txt', 'kept content');
    const leaseToken = crypto.randomUUID();
    const resolved = await resolveDraftAttachments(env, owner.id, [kept.token], leaseToken);
    expect((await leasesOf()).map((lease) => [lease.r2Key, lease.token])).toEqual([[draftKey(owner.id, kept.token), leaseToken]]);
    await db.update(draftAttachments).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(draftAttachments.token, kept.token));
    expect(await runDraftAttachmentCleanup(env)).toBeGreaterThanOrEqual(1);
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(draftKey(owner.id, kept.token))).not.toBeNull();
    const summary = await sendMail(runtime, { waitUntil: () => {} }, owner.sender, {
      from: { localPart: 'x2-draft-expiry', domain: 'hpc.email' }, to: ['far@example.net'], cc: [], bcc: [], subject: 'x2 expired draft', text: 'x',
    }, resolved, 'https://hpc.email', null, leaseToken);
    expect(summary.status).toBe('sent');
    expect(new TextDecoder().decode(captured[0]!.mail.attachments[0]!.content as ArrayBuffer)).toBe('kept content');
    expect(await leasesOf()).toEqual([]);

    // 投递前失败（发件地址不可用）：租约随错误释放，草稿删除后对象正常回收
    const lone = await upload(runtime, owner.key, 'lone.txt', 'lone content');
    expect((await body(await call(runtime, '/v1/messages', json(owner.key, {
      from: 'someone-else@hpc.email', to: ['far@example.net'], subject: 'x2 forbidden', text: 'x', attachmentTokens: [lone.token],
    })), 403)).error!.code).toBe('forbidden');
    expect(await leasesOf()).toEqual([]);
    expect((await call(runtime, `/v1/uploads/${lone.token}`, { method: 'DELETE', headers: auth(owner.key) })).status).toBe(200);
    await processStorageCleanup(env, 1000);
    expect(await env.r2.get(draftKey(owner.id, lone.token))).toBeNull();
  });

  it('草稿在解析前已被删除：校验失败，不留下租约', async () => {
    const owner = await account('x2-draft-gone');
    const { runtime } = mailEnv();
    const gone = await upload(runtime, owner.key, 'gone.txt', 'gone');
    const other = await upload(runtime, owner.key, 'other.txt', 'other');
    expect((await call(runtime, `/v1/uploads/${gone.token}`, { method: 'DELETE', headers: auth(owner.key) })).status).toBe(200);
    expect((await body(await call(runtime, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'x2 gone', text: 'x', attachmentTokens: [other.token, gone.token],
    })), 400)).error!.code).toBe('validation_failed');
    expect(await leasesOf()).toEqual([]);
  });

  it('转发原附件：校验之后、投递之前原邮件被永久删除，对象仍可用，投递后按引用回收', async () => {
    const owner = await account('x2-forward-race');
    const { runtime, captured } = mailEnv();
    const [source] = await db.insert(messages).values({ direction: 'inbound', address: owner.address, domain: 'hpc.email',
      status: 'received', subject: 'x2 forward source' }).returning({ id: messages.id });
    const key = `att/${source!.id}/0-x2-forward.txt`;
    await env.r2.put(key, 'original content');
    await db.insert(attachments).values({ messageId: source!.id, r2Key: key, filename: 'original.txt', mimeType: 'text/plain', size: 16 });
    const hooked = beforeOutboundInsert(async () => {
      expect(await purgeMatchingMessages(env, eq(messages.id, source!.id))).toBe(1);
      await processStorageCleanup(env, 1000);
      expect(await env.r2.head(key)).not.toBeNull();
    });
    const sent = await body(await call({ ...runtime, db: hooked } as Env, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'Fwd: x2', text: 'see attached', forwardAttachmentsFrom: source!.id,
    })), 201);
    expect(sent.data!.status).toBe('sent');
    expect(new TextDecoder().decode(captured[0]!.mail.attachments[0]!.content as ArrayBuffer)).toBe('original content');
    expect(await leasesOf()).toEqual([]);
    await processStorageCleanup(env, 1000);
    expect(await (await env.r2.get(key))?.text()).toBe('original content');
    await purgeMatchingMessages(env, eq(messages.id, sent.data!.id));
    await processStorageCleanup(env, 1000);
    expect(await env.r2.get(key)).toBeNull();
  });

  it('转发：原邮件在可见性校验之后被删除时报 source_unavailable，不静默发出缺附件的邮件', async () => {
    const owner = await account('x2-forward-gone');
    const { runtime, send } = mailEnv();
    const [source] = await db.insert(messages).values({ direction: 'inbound', address: owner.address, domain: 'hpc.email',
      status: 'received', subject: 'x2 forward gone' }).returning({ id: messages.id });
    const key = `att/${source!.id}/0-x2-gone.txt`;
    await env.r2.put(key, 'gone content');
    await db.insert(attachments).values({ messageId: source!.id, r2Key: key, filename: 'gone.txt', mimeType: 'text/plain', size: 12 });
    // 可见性校验刚结束、登记租约的 batch 执行之前删除原邮件
    const racing = leaseSpy(async () => { await purgeMatchingMessages(env, eq(messages.id, source!.id)); });
    const failed = await body(await call({ ...runtime, db: racing } as Env, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'Fwd: gone', text: 'x', forwardAttachmentsFrom: source!.id,
    })), 404);
    expect(failed.error!.code).toBe('source_unavailable');
    expect(send).not.toHaveBeenCalled();
    expect(await leasesOf()).toEqual([]);
  });

  it('租约登记语句按 token 唯一索引与 message_id 索引取行，不扫草稿表与附件表', async () => {
    const owner = await account('x2-lease-plan');
    const { runtime } = mailEnv();
    const draft = await upload(runtime, owner.key, 'plan.txt', 'plan');
    const [source] = await db.insert(messages).values({ direction: 'inbound', address: owner.address, domain: 'hpc.email',
      status: 'received', subject: 'x2 plan source' }).returning({ id: messages.id });
    await env.r2.put(`att/${source!.id}/0-plan.txt`, 'plan');
    await db.insert(attachments).values({ messageId: source!.id, r2Key: `att/${source!.id}/0-plan.txt`, filename: 'plan.txt', mimeType: 'text/plain', size: 4 });
    const spy = leaseSpy();
    await body(await call({ ...runtime, db: spy } as unknown as Env, '/v1/messages', json(owner.key, {
      from: owner.address, to: ['far@example.net'], subject: 'x2 plan', text: 'x', attachmentTokens: [draft.token], forwardAttachmentsFrom: source!.id,
    })), 201);
    expect(spy.recorded).toHaveLength(2);
    const plans = await Promise.all(spy.recorded.map(async ({ sql, params }) =>
      (await env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((row) => row.detail).join(' | ')));
    expect(plans[0]).toMatch(/SEARCH draft_attachments USING INDEX draft_attachments_token_unique \(token=\?\)/);
    expect(plans[1]).toMatch(/SEARCH attachments USING (?:COVERING )?INDEX idx_attachments_message(?:_object)? \(message_id=\?\)/);
    for (const plan of plans) expect(plan).not.toMatch(/SCAN (?:draft_attachments|attachments)\b/);
  });
});

describe('C3 地址写法的发件显示名', () => {
  it('邮箱配置了 displayName 时字符串与对象写法都用它；显式名优先；管理员无邮箱行的任意前缀沿用前缀', async () => {
    const owner = await account('x2-display');
    await db.update(mailboxes).set({ displayName: 'Configured Name' }).where(eq(mailboxes.id, owner.boxId));
    const { runtime, captured } = mailEnv();
    const send = async (key: string, from: unknown, subject: string) =>
      (await body(await call(runtime, '/v1/messages', json(key, { from, to: ['n@example.net'], subject, text: 'x' })), 201)).data!;
    for (const [from, subject] of [[owner.address, 'string'], [{ address: owner.address }, 'object'],
      [{ localPart: 'x2-display', domain: 'hpc.email' }, 'legacy'], [{ mailboxId: owner.boxId }, 'mailbox id']] as const) {
      const sent = await send(owner.key, from, `x2 display ${subject}`);
      expect(sent.fromName, subject).toBe('Configured Name');
      expect(captured.at(-1)!.mail.from, subject).toEqual({ address: owner.address, name: 'Configured Name' });
    }
    expect((await send(owner.key, `Explicit <${owner.address}>`, 'x2 display explicit')).fromName).toBe('Explicit');
    expect((await send(owner.key, { address: owner.address, name: 'Object Name' }, 'x2 display object name')).fromName).toBe('Object Name');

    const admin = await account('x2-display-admin', 'admin');
    expect((await send(admin.key, 'nobox-x2@hpc.email', 'x2 display arbitrary')).fromName).toBe('nobox-x2');
    expect(captured.at(-1)!.mail.from).toEqual({ address: 'nobox-x2@hpc.email', name: 'nobox-x2' });
    expect((await send(admin.key, owner.address, 'x2 display admin other')).fromName).toBe('Configured Name');
  });
});
