import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { Hono } from 'hono';
import {
  MAX_AUTH_USER_REQUESTS_PER_MINUTE,
  MAX_WAIT_POLLS_PER_USER_PER_MINUTE,
} from '@hpc-mail/shared';
import { createApp, isApiPath } from '../src/app.js';
import worker from '../src/index.js';
import { createDb } from '../src/db/client.js';
import { apiKeys, mailboxShares, mailboxes, messages, notificationJobs, sessions, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { requireAuth } from '../src/middleware/auth.js';
import { createApiKey } from '../src/services/api-key.js';
import { handleInbound } from '../src/services/inbound.js';
import { extractCodeByRegex, resolveVerificationCode } from '../src/services/code-extract.js';
import { getRoutableDomains } from '../src/services/domain.js';
import { buildFeishuEmailCard, sendFeishuNotification } from '../src/services/feishu.js';
import { countUnread, getThread, markAllRead } from '../src/services/message.js';
import { enqueueMailNotifications, processNotificationJobs } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { sendMail } from '../src/services/outbound.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';
import { createSession } from '../src/services/session.js';
import { getSettings, invalidateSettingsMemory, updateSettings } from '../src/services/setting.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function seedUser(username: string, opts: { role?: 'admin' | 'user'; migrated?: boolean; status?: 'active' | 'disabled' } = {}) {
  const [row] = await createDb(env).insert(users).values({
    username, passwordHash: 'x', role: opts.role ?? 'user', status: opts.status ?? 'active',
    authVersionMigrated: opts.migrated ?? true,
  }).returning({ id: users.id });
  return row!.id;
}

async function tokenFor(userId: number, uepoch = 0) {
  const sid = await createSession(env, userId);
  return { sid, jwt: await signToken(env.jwt_secret, { sub: userId, sid, epoch: 0, uepoch }) };
}

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}


/** 记录经过 env.db 的语句（prepare 的 SQL 与 batch 调用次数），不改变执行结果 */
function recordingEnv() {
  const prepared: string[] = [];
  let batches = 0;
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => { prepared.push(query); return target.prepare(query); };
      if (property === 'batch') return (statements: D1PreparedStatement[]) => { batches++; return target.batch(statements); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, db }, prepared, batches: () => batches };
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.9', ...extra } });
const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;
const authCount = async (userId: number) => (await readCounter(env, 'auth-user', String(userId), minuteWindow(1))).count;

describe('JWT 鉴权单次往返', () => {
  it('有效会话一次 batch 完成鉴权，限流计数各加一', async () => {
    const id = await seedUser('perf-auth-fast');
    const { jwt } = await tokenFor(id);
    const before = await authCount(id);
    const response = await request('/api/auth/me', bearer(jwt));
    expect(response.status).toBe(200);
    expect(await authCount(id)).toBe(before + 1);
  });

  it('快路径只发一次 D1 batch（会话+用户+设置+两条计数），不读密码哈希等敏感列', async () => {
    const id = await seedUser('perf-auth-roundtrip');
    const { jwt } = await tokenFor(id);
    const probe = new Hono<{ Bindings: typeof env }>();
    probe.use('*', requireAuth as never);
    probe.get('/probe', (c) => c.json({ ok: true }));
    const recorded = recordingEnv();
    const response = await probe.request('/probe', bearer(jwt), recorded.env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(recorded.batches()).toBe(1);
    expect(recorded.prepared).toHaveLength(4);
    expect(recorded.prepared.join('\n')).not.toMatch(/password_hash|totp_secret|totp_recovery_codes/);
  });

  it('撤销会话、禁用账号、改密（版本号变化）立即失效且不计数', async () => {
    const id = await seedUser('perf-auth-revoke');
    const { sid, jwt } = await tokenFor(id);
    expect((await request('/api/auth/me', bearer(jwt))).status).toBe(200);
    const counted = await authCount(id);

    await createDb(env).update(users).set({ authVersion: 1 }).where(eq(users.id, id));
    const bumped = await request('/api/auth/me', bearer(jwt));
    expect(bumped.status).toBe(401);
    await createDb(env).update(users).set({ authVersion: 0, status: 'disabled' }).where(eq(users.id, id));
    const disabled = await request('/api/auth/me', bearer(jwt));
    expect(await errorCode(disabled)).toBe('user_disabled');
    await createDb(env).update(users).set({ status: 'active' }).where(eq(users.id, id));
    await createDb(env).update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sid));
    const revoked = await request('/api/auth/me', bearer(jwt));
    expect(revoked.status).toBe(401);
    expect(await authCount(id)).toBe(counted);
  });

  it('会话行缺失的旧 KV 会话与未迁移版本走慢路径，计数不重复', async () => {
    const id = await seedUser('perf-auth-legacy', { migrated: false });
    const sid = crypto.randomUUID();
    await env.kv.put(`sess:${sid}`, JSON.stringify({ userId: id, createdAt: Date.now() }));
    const jwt = await signToken(env.jwt_secret, { sub: id, sid, epoch: 0, uepoch: 0 });
    const before = await authCount(id);
    expect((await request('/api/auth/me', bearer(jwt))).status).toBe(200);
    expect(await authCount(id)).toBe(before + 1);
    expect(await createDb(env).select().from(sessions).where(eq(sessions.id, sid)).get()).toBeDefined();
    expect((await createDb(env).select().from(users).where(eq(users.id, id)).get())!.authVersionMigrated).toBe(true);
    // 迁移完成后的下一次请求走快路径，同样只计一次
    expect((await request('/api/auth/me', bearer(jwt))).status).toBe(200);
    expect(await authCount(id)).toBe(before + 2);
  });

  it('超过每分钟上限返回 rate_limited', async () => {
    const id = await seedUser('perf-auth-limit');
    const { jwt } = await tokenFor(id);
    const minute = minuteWindow(1);
    for (const window of [minute, minute + 1]) {
      await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, ?, 0)')
        .bind('auth-user', String(id), window, MAX_AUTH_USER_REQUESTS_PER_MINUTE).run();
    }
    expect(await errorCode(await request('/api/auth/me', bearer(jwt)))).toBe('rate_limited');
  });

  it('require2fa 直接读 D1 设置：未绑定账号只能访问豁免路径', async () => {
    const id = await seedUser('perf-auth-2fa');
    const { jwt } = await tokenFor(id);
    await updateSettings(env, { security: { require2fa: true } });
    try {
      expect(await errorCode(await request('/api/mailboxes', bearer(jwt)))).toBe('totp_setup_required');
      expect((await request('/api/auth/me', bearer(jwt))).status).toBe(200);
    } finally {
      await updateSettings(env, { security: { require2fa: false } });
    }
    expect((await request('/api/mailboxes', bearer(jwt))).status).toBe(200);
  });
});

describe('settings 读取缓存', () => {
  it('isolate 内存缓存命中直写的旧值，updateSettings 立即失效；KV 回填走 waitUntil', async () => {
    invalidateSettingsMemory();
    await env.kv.delete('setting-cache');
    const ctx = createExecutionContext();
    const first = await getSettings(env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.kv.get('setting-cache')).not.toBeNull();
    await env.db.prepare("INSERT INTO settings (key, value) VALUES ('site', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify({ ...first.site, title: 'Direct Write Title' })).run();
    expect((await getSettings(env)).site.title).toBe(first.site.title);
    await updateSettings(env, { site: { ...first.site, title: 'Updated Title' } });
    expect((await getSettings(env)).site.title).toBe('Updated Title');
    await updateSettings(env, { site: first.site });
  });
});

describe('/v1 鉴权写入合并', () => {
  async function key(username: string, rateLimit = 120) {
    const id = await seedUser(username);
    const created = await createApiKey(env, id, { name: username, scopes: ['mail.read'], rateLimit, allowedIps: [] });
    return { id, key: created.key, keyId: created.id };
  }

  it('last_used 60 秒内只写一次', async () => {
    const k = await key('perf-v1-last-used');
    expect((await request('/v1/status', bearer(k.key))).status).toBe(200);
    const first = (await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, k.keyId)).get())!.lastUsedAt!;
    expect(first).toBeInstanceOf(Date);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await request('/v1/status', bearer(k.key))).status).toBe(200);
    expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, k.keyId)).get())!.lastUsedAt!.getTime()).toBe(first.getTime());
    await createDb(env).update(apiKeys).set({ lastUsedAt: new Date(Date.now() - 61_000) }).where(eq(apiKeys.id, k.keyId));
    expect((await request('/v1/status', bearer(k.key))).status).toBe(200);
    expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, k.keyId)).get())!.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('Key 级超限时不计入用户总桶、不刷新 last_used', async () => {
    const k = await key('perf-v1-key-limit', 1);
    const minute = minuteWindow(1);
    expect((await request('/v1/status', bearer(k.key))).status).toBe(200);
    await createDb(env).update(apiKeys).set({ lastUsedAt: new Date(0) }).where(eq(apiKeys.id, k.keyId));
    const limited = await request('/v1/status', bearer(k.key));
    expect(await errorCode(limited)).toBe('rate_limited');
    if (minuteWindow(1) === minute) {
      expect((await readCounter(env, 'api-user', String(k.id), minute)).count).toBe(1);
      expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, k.keyId)).get())!.lastUsedAt!.getTime()).toBe(0);
    }
  });

  it('wait 命中时只计 1 次轮询；预占超出上限立即拒绝且只计 1 次', async () => {
    const id = await seedUser('perf-v1-wait');
    const created = await createApiKey(env, id, { name: 'wait', scopes: ['mail.read'], rateLimit: 120, allowedIps: [] });
    await createDb(env).insert(mailboxes).values({ address: 'perf-wait@hpc.email', domain: 'hpc.email', userId: id });
    const [hit] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'perf-wait@hpc.email', domain: 'hpc.email', status: 'received', subject: 'wait hit' }).returning({ id: messages.id });
    const minute = minuteWindow(1);
    const response = await request(`/v1/messages/wait?timeout=25&afterId=${hit!.id - 1}`, bearer(created.key));
    expect(((await response.json()) as { data: { message: { id: number } } }).data.message.id).toBe(hit!.id);
    if (minuteWindow(1) === minute) expect((await readCounter(env, 'api-wait', String(id), minute)).count).toBe(1);

    const now = minuteWindow(1);
    for (const window of [now, now + 1]) {
      await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, ?, 0) ON CONFLICT(scope, subject, "window") DO UPDATE SET count = excluded.count')
        .bind('api-wait', String(id), window, MAX_WAIT_POLLS_PER_USER_PER_MINUTE - 1).run();
    }
    const rejected = await request(`/v1/messages/wait?timeout=1&afterId=${hit!.id}`, bearer(created.key));
    expect(await errorCode(rejected)).toBe('rate_limited');
    const counts = await Promise.all([now, now + 1].map(window => readCounter(env, 'api-wait', String(id), window)));
    expect(counts.map(c => c.count).sort()).toEqual([MAX_WAIT_POLLS_PER_USER_PER_MINUTE - 1, MAX_WAIT_POLLS_PER_USER_PER_MINUTE]);
  });
});

describe('入口路由与可观测性', () => {
  it('/api、/v1 只匹配精确路径或子路径', () => {
    for (const path of ['/api', '/api/', '/api/config', '/v1', '/v1/status']) expect(isApiPath(path)).toBe(true);
    for (const path of ['/api-keys', '/apis', '/v1beta', '/v10/status', '/inbox']) expect(isApiPath(path)).toBe(false);
  });

  it('/api-keys 前端路由交给静态资源；API 响应带 Server-Timing', async () => {
    const assets = { fetch: async () => new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher;
    const spa = await worker.fetch(new Request('https://mail.example/api-keys'), { ...env, assets }, createExecutionContext());
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe('<html>SPA</html>');
    const ctx = createExecutionContext();
    const api = await worker.fetch(new Request('https://mail.example/api/config'), { ...env, assets }, ctx);
    await waitOnExecutionContext(ctx);
    expect(api.status).toBe(200);
    expect(api.headers.get('Server-Timing')).toMatch(/^app;dur=\d+, d1;desc="n=\d+"$/);
  });

  it('超过 1.5 秒的 API 请求输出一行结构化慢日志（路由去掉查询串与数字 id）', async () => {
    const id = await seedUser('perf-slow-log');
    const created = await createApiKey(env, id, { name: 'slow', scopes: ['mail.read'], rateLimit: 120, allowedIps: [] });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://mail.example/v1/messages/wait?timeout=2&afterId=999999', {
      headers: { Authorization: `Bearer ${created.key}`, 'CF-Connecting-IP': '203.0.113.9' },
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const slow = logs.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .find(entry => entry?.event === 'slow_request');
    expect(slow).toMatchObject({ route: 'GET /v1/messages/wait', status: 200 });
    expect(slow!.ms as number).toBeGreaterThan(1500);
    expect(typeof slow!.d1Calls).toBe('number');
  });
});

describe('未读计数与线程查询改写保持语义', () => {
  it('未读 = 认领地址 + 启用管理员分享的未删除收件，口径与原 OR 条件一致', async () => {
    const db = createDb(env);
    const admin = await seedUser('perf-unread-admin', { role: 'admin' });
    const disabledAdmin = await seedUser('perf-unread-off', { role: 'admin', status: 'disabled' });
    const viewer = await seedUser('perf-unread-viewer');
    const [shared] = await db.insert(mailboxes).values({ address: 'perf-shared@hpc.email', domain: 'hpc.email', userId: admin }).returning({ id: mailboxes.id });
    const [stale] = await db.insert(mailboxes).values({ address: 'perf-stale@hpc.email', domain: 'hpc.email', userId: disabledAdmin }).returning({ id: mailboxes.id });
    await db.insert(mailboxes).values({ address: 'perf-own@hpc.email', domain: 'hpc.email', userId: viewer });
    await db.insert(mailboxShares).values([{ mailboxId: shared!.id, userId: viewer, grantedBy: admin }, { mailboxId: stale!.id, userId: viewer, grantedBy: disabledAdmin }]);
    const mail = (address: string, extra: Partial<typeof messages.$inferInsert> = {}) => ({ direction: 'inbound' as const, address, domain: 'hpc.email', status: 'received', subject: 'u', ...extra });
    for (const row of [
      mail('perf-own@hpc.email'), mail('perf-own@hpc.email'), mail('perf-own@hpc.email', { isRead: true }),
      mail('perf-own@hpc.email', { deletedAt: new Date() }), mail('perf-own@hpc.email', { direction: 'outbound', isRead: false }),
      mail('perf-shared@hpc.email'), mail('perf-shared@hpc.email', { deletedAt: new Date() }),
      mail('perf-stale@hpc.email'), mail('perf-unrelated@hpc.email'),
    ]) await db.insert(messages).values(row);
    expect(await countUnread(env, viewer, 'user')).toBe(3);
    expect(await countUnread(env, admin, 'admin')).toBe(1);
    expect(await markAllRead(env, { userId: viewer, role: 'user', scope: 'mine' })).toBe(3);
    expect(await countUnread(env, viewer, 'user')).toBe(0);
    expect(await countUnread(env, admin, 'admin')).toBe(0);
  });

  it('线程按邮件头多轮扩展、排除已删除与不可见邮件，只返回摘要', async () => {
    const db = createDb(env);
    const owner = await seedUser('perf-thread-owner');
    const other = await seedUser('perf-thread-other');
    await db.insert(mailboxes).values([
      { address: 'perf-thread@hpc.email', domain: 'hpc.email', userId: owner },
      { address: 'perf-thread-other@hpc.email', domain: 'hpc.email', userId: other },
    ]);
    const base = { address: 'perf-thread@hpc.email', domain: 'hpc.email', status: 'received', bodyText: 'secret body', bodyHtml: '<p>secret</p>' };
    const [a] = await db.insert(messages).values({ ...base, direction: 'inbound', subject: 'Plan', messageId: '<a@x>' }).returning({ id: messages.id });
    const [b] = await db.insert(messages).values({ ...base, direction: 'outbound', subject: 'Re: Plan', messageId: '<b@x>', inReplyTo: '<a@x>' }).returning({ id: messages.id });
    const [c] = await db.insert(messages).values({ ...base, direction: 'inbound', subject: 'Re: Plan', messageId: '<c@x>', inReplyTo: '<b@x>', references: '<a@x> <b@x>' }).returning({ id: messages.id });
    await db.insert(messages).values({ ...base, direction: 'inbound', subject: 'Re: Plan', messageId: '<d@x>', inReplyTo: '<c@x>', deletedAt: new Date() });
    await db.insert(messages).values({ ...base, address: 'perf-thread-other@hpc.email', direction: 'inbound', subject: 'Re: Plan', messageId: '<e@x>', inReplyTo: '<c@x>' });
    const thread = await getThread(env, { userId: owner, role: 'user' }, a!.id);
    expect(thread.map(item => item.id)).toEqual([a!.id, b!.id, c!.id]);
    expect(thread.every(item => !('bodyText' in item) && !('bodyHtml' in item))).toBe(true);

    const [lone] = await db.insert(messages).values({ ...base, direction: 'inbound', subject: 'Weekly sync' }).returning({ id: messages.id });
    const [reply] = await db.insert(messages).values({ ...base, direction: 'inbound', subject: 'RE: weekly sync' }).returning({ id: messages.id });
    expect((await getThread(env, { userId: owner, role: 'user' }, lone!.id)).map(item => item.id)).toEqual([lone!.id, reply!.id]);
    await expect(getThread(env, { userId: other, role: 'user' }, a!.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('收件链路往返', () => {
  it('归属人偏好只读一次，转发、入队与即时投递共用；无附件新邮件直接落为 received', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0 })));
    const owner = await seedUser('perf-inbound-owner');
    await createDb(env).insert(mailboxes).values({ address: 'perf-inbound@hpc.email', domain: 'hpc.email', userId: owner });
    await updateUserNotifyPrefs(env, owner, {
      pushdeer: { enabled: true, endpoint: '', pushkey: 'PDU_SYNTHETIC_TEST' },
      webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' },
    });
    const raw = ['From: Shop <shop@example.net>', 'To: perf-inbound@hpc.email', 'Subject: Your login code',
      'Message-ID: <perf-inbound@example.net>', 'Content-Type: text/plain; charset=utf-8', '', 'Your verification code is 482913.', ''].join('\r\n');
    const recorded = recordingEnv();
    const ctx = createExecutionContext();
    await handleInbound({ raw: new Response(raw).body!, headers: new Headers(), to: 'perf-inbound@hpc.email', from: 'shop@example.net',
      forward: vi.fn(async () => {}), setReject: vi.fn() } as never, recorded.env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(recorded.prepared.filter(sql => /notify_prefs/.test(sql) && /from "users"/.test(sql))).toHaveLength(1);
    expect(recorded.prepared.filter(sql => /^update "messages" set "status"/.test(sql))).toHaveLength(0);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, 'perf-inbound@hpc.email')).get();
    expect(row).toMatchObject({ status: 'received', verificationCode: '482913' });
    const jobs = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).all();
    expect(jobs.map(job => [job.channel, job.status]).sort()).toEqual([['pushdeer', 'succeeded'], ['webhook', 'succeeded']]);
    expect(row!.notificationsQueuedAt).not.toBeNull();
  });
});

describe('验证码提取', () => {
  it('识别紧贴关键词的 5 位 Steam Guard 码', () => {
    expect(extractCodeByRegex('Your Steam account', 'Your Steam Guard code: 4KQ7P')).toBe('4KQ7P');
    expect(extractCodeByRegex('', 'Login Code\nF7GHT\nIf this was not you, change your password.')).toBe('F7GHT');
    expect(extractCodeByRegex('Steam Guard', 'Here is the Steam Guard code you need to login to account foo:\n\nRTVWX')).toBe('RTVWX');
    expect(resolveVerificationCode('Steam', 'Steam Guard code: 4KQ7P', '')).toBe('4KQ7P');
  });

  it('普通 5 字母单词与不紧贴关键词的短串不误判', () => {
    expect(extractCodeByRegex('', 'Promo code: HAPPY')).toBe('');
    expect(extractCodeByRegex('', 'Error code: ABORT')).toBe('');
    expect(extractCodeByRegex('', 'Use code at checkout. Visit our STORE today, 4KQ7P members save more.')).toBe('');
    expect(extractCodeByRegex('', 'Your code was sent. Reference ID AB12C for support.')).toBe('');
  });

  it('只扫描正文前 16KB，长正文保持线性耗时', () => {
    // 约 1MB：大量 URL 区间与数字候选，原实现是候选数 × URL 数的平方复杂度
    const filler = 'https://tracker.example/click?id=12345678 news 2026 '.repeat(20_000);
    const started = Date.now();
    expect(extractCodeByRegex('Newsletter', `${filler}\nYour verification code is 654321`)).toBe('');
    expect(resolveVerificationCode('Newsletter', `${filler}\nYour verification code is 654321`, '')).toBe('');
    expect(Date.now() - started).toBeLessThan(200);
    expect(extractCodeByRegex('Login', `Your verification code is 654321\n${filler}`)).toBe('654321');
  });
});

describe('飞书通知', () => {
  const info = {
    subject: 'Reset for alice@example.com', fromAddress: 'noreply@service.example', fromName: 'Service <noreply@service.example>',
    toAddress: 'me@hpc.email', code: '123456', body: 'Hi alice@example.com, contact help@service.example.', link: 'https://hpc.email/mail/42',
  };

  it('卡片不含任何完整邮箱地址，并带「打开邮件」按钮', () => {
    const card = JSON.stringify(buildFeishuEmailCard(info, false, 'full'));
    expect(card).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(card).toContain('[邮箱已隐藏]');
    expect(card).toContain('m***（hpc.email）');
    expect(card).toContain('no***（service.example）');
    expect(card).toContain('"url":"https://hpc.email/mail/42"');
    expect(card).toContain('打开邮件');
  });

  it('内容审核拒收 11312 不重试，健康页能看到原因', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Response.json({ code: 11312, msg: 'bot messages do not pass the audit' }));
    vi.stubGlobal('fetch', fetchMock);
    const feishu = { enabled: true, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secret: '', contentLevel: 'summary' as const };
    await expect(sendFeishuNotification(feishu, info, { throwOnError: true, attempts: 3 })).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const userId = await seedUser('perf-feishu-audit');
    await updateUserNotifyPrefs(env, userId, { feishu });
    const ids = await enqueueMailNotifications(env, null, { ownerIds: [userId], text: 'body', message: {
      id: 990_001, address: 'perf-feishu@hpc.email', fromAddress: 'a@example.net', fromName: '', subject: 's',
      verificationCode: '', preview: 'body', createdAt: new Date().toISOString(),
    } });
    await processNotificationJobs(env, { jobIds: ids });
    const job = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.id, ids[0]!)).get();
    expect(job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job!.lastError).toContain('11312');
    expect(job!.lastError).toContain('内容安全审核');
  });
});

describe('外发与可路由域名', () => {
  async function sender(username: string) {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
      code_extract: { enabled: false, aiEnabled: false },
      quota: { dailyOutbound: 0, dailyRecipients: 0 },
    });
    const id = await seedUser(username, { role: 'admin' });
    await createDb(env).insert(mailboxes).values({ address: `${username}@hpc.email`, domain: 'hpc.email', userId: id });
    return { userId: id, role: 'admin' as const };
  }

  it('外部收件人共用同一份原文，Bcc 不进头；无 To 时 To 头随收件人', async () => {
    const from = await sender('perf-mime');
    const sent: { to: string; raw: string }[] = [];
    const customEnv = { ...env, email: { send: async (mail: { to: string; raw: string }) => { sent.push({ to: mail.to, raw: mail.raw }); } } } as never;
    const ctx = createExecutionContext();
    await sendMail(customEnv, ctx, from, { from: { localPart: 'perf-mime', domain: 'hpc.email' },
      to: ['a@example.net'], cc: ['b@example.net'], bcc: ['c@example.net'], subject: 'shared mime', text: 'body' }, [], 'https://hpc.email');
    expect(sent.map(item => item.to).sort()).toEqual(['a@example.net', 'b@example.net', 'c@example.net']);
    expect(new Set(sent.map(item => item.raw)).size).toBe(1);
    const parsed = await PostalMime.parse(sent[0]!.raw);
    expect(parsed.bcc).toBeUndefined();
    expect(sent[0]!.raw).not.toContain('c@example.net');

    sent.length = 0;
    await sendMail(customEnv, ctx, from, { from: { localPart: 'perf-mime', domain: 'hpc.email' },
      to: [], cc: [], bcc: ['x@example.net', 'y@example.net'], subject: 'bcc only', text: 'body' }, [], 'https://hpc.email');
    await waitOnExecutionContext(ctx);
    for (const item of sent) expect((await PostalMime.parse(item.raw)).to?.map(entry => entry.address)).toEqual([item.to]);
  });

  it('按候选域查询的可路由结果与全量一致', async () => {
    await sender('perf-routable');
    await createDb(env).insert(mailboxes).values({ address: 'legacy@removed.example', domain: 'removed.example', userId: 1 });
    const full = await getRoutableDomains(env);
    const scoped = await getRoutableDomains(env, undefined, ['removed.example', 'gmail.com', 'hpc.email']);
    for (const domain of ['removed.example', 'gmail.com', 'hpc.email']) expect(scoped.includes(domain)).toBe(full.includes(domain));
    expect(scoped).toContain('removed.example');
    expect(scoped).not.toContain('gmail.com');
  });
});

describe('定时任务', () => {
  it('某一步失败不影响后续步骤，并输出一行汇总日志', async () => {
    const userId = await seedUser('perf-cron');
    await createDb(env).insert(sessions).values({ id: 'perf-expired-session', userId, createdAt: new Date(0), expiresAt: new Date(1000) });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const faulty = { ...env, db: new Proxy(env.db, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => {
          if (/from "notification_jobs" where \("notification_jobs"\."created_at" </.test(query)) throw new Error('injected failure');
          return target.prepare(query);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) };
    await runScheduled(faulty as never, true);
    expect(await createDb(env).select().from(sessions).where(eq(sessions.id, 'perf-expired-session')).get()).toBeUndefined();
    const summary = JSON.parse(logs.find(line => line.includes('"event":"scheduled"'))!) as { steps: { step: string; failed?: boolean }[] };
    expect(summary.steps.find(step => step.step === 'notification.cleanup')).toMatchObject({ failed: true });
    expect(summary.steps.find(step => step.step === 'sessions.cleanup')).not.toHaveProperty('failed');
    expect(summary.steps.map(step => step.step)).toContain('counters');
  });

  it('补录查询使用待补录部分索引', async () => {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages INDEXED BY idx_messages_notification_outbox
      WHERE notify_owner_ids IS NOT NULL AND notifications_queued_at IS NULL AND deleted_at IS NULL
        AND direction = 'inbound' AND status IN ('received', 'degraded') ORDER BY created_at, id LIMIT 30`).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(' ')).toContain('idx_messages_notification_outbox');
    const purge = await env.db.prepare('EXPLAIN QUERY PLAN SELECT DISTINCT purge_token FROM messages WHERE purge_token IS NOT NULL LIMIT 20').all<{ detail: string }>();
    expect(purge.results.map(row => row.detail).join(' ')).toContain('idx_messages_purge_token');
    const r2 = await env.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM messages WHERE body_r2_key = ? OR raw_r2_key = ?').bind('k', 'k').all<{ detail: string }>();
    const detail = r2.results.map(row => row.detail).join(' ');
    expect(detail).toContain('idx_messages_body_r2');
    expect(detail).toContain('idx_messages_raw_r2');
  });
});

