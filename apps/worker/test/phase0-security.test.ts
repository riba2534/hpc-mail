import { type ApiScope, type ChangePasswordResponse } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import {
  adminAuditLogs,
  apiKeys,
  apiRateLimits,
  apiRequestLogs,
  idempotencyRecords,
  mailboxes,
  messages,
  notificationJobs,
  users,
} from '../src/db/schema.js';
import { AppError } from '../src/lib/errors.js';
import { signToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';
import { createApiKey, revokeAllApiKeysQuery, revokeApiKey, updateApiKey } from '../src/services/api-key.js';
import {
  beginIdempotentSend,
  bindIdempotentSend,
  completeIdempotentSend,
  failIdempotentSend,
  type IdempotencyActor,
  type IdempotencyHandle,
} from '../src/services/idempotency.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { sendMail } from '../src/services/outbound.js';
import { runScheduled } from '../src/services/scheduled.js';
import { enqueueMailNotifications, processNotificationJobs, retryNotificationJob } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import { fakeRateLimits } from './fake-rate-limits.js';

const app = createApp();
const IP = '198.51.100.23';
const webhook = { enabled: true, url: 'https://notify.example.com/p0', secret: '' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const rand = () => crypto.randomUUID().slice(0, 8);

async function seedUser(name: string, opts: { role?: 'admin' | 'user'; password?: string; migrated?: boolean } = {}) {
  const [row] = await createDb(env).insert(users).values({
    username: `${name}-${rand()}`,
    passwordHash: opts.password ? await hashPassword(opts.password) : 'x',
    role: opts.role ?? 'user',
    status: 'active',
    authVersionMigrated: opts.migrated ?? true,
  }).returning();
  return row!;
}

async function jwtFor(userId: number) {
  const sid = await createSession(env, userId);
  return signToken(env.jwt_secret, { sub: userId, sid, epoch: 0, uepoch: 0 });
}

async function keyFor(userId: number, opts: { rateLimit?: number; allowedIps?: string[]; scopes?: ApiScope[] } = {}) {
  return createApiKey(env, userId, {
    name: `p0-${rand()}`,
    scopes: opts.scopes ?? ['mail.read'],
    rateLimit: opts.rateLimit ?? 120,
    allowedIps: opts.allowedIps ?? [],
  });
}

async function call(path: string, token: string, init: RequestInit = {}, target: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': IP, ...(init.headers as Record<string, string> | undefined) },
  }, target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const jsonInit = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const logsOf = (apiKeyId: number) => createDb(env).select().from(apiRequestLogs).where(eq(apiRequestLogs.apiKeyId, apiKeyId)).all();

/** 按分钟计的断言在窗口边界附近会跨格，离整分钟不足 5 秒时等到下一分钟 */
async function awayFromMinuteBoundary(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

/** 匹配的语句真正执行前先跑一次 hook，用来在「读校验」与「写」之间插入并发操作 */
function beforeStatement(pattern: RegExp, hook: () => Promise<unknown>): Env {
  let triggered = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (!triggered && ['first', 'all', 'run', 'raw'].includes(String(property))) { triggered = true; await hook(); }
        return method.apply(target, args);
      };
    },
  });
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => pattern.test(query) ? wrap(target.prepare(query)) : target.prepare(query);
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) } as Env;
}

async function enableApi() {
  await updateSettings(env, { api: { enabled: true }, security: { require2fa: false } });
}

describe('R03 /v1 审计写入受控', () => {
  it('X-Request-ID 只接受短的安全字符，否则换成服务端 UUID，审计里记实际使用的 ID', async () => {
    await enableApi();
    const user = await seedUser('p0-reqid');
    const key = await keyFor(user.id);
    const valid = await call('/v1/status', key.key, { headers: { 'X-Request-ID': 'trace-1:Ab.9_x' } });
    expect(valid.headers.get('X-Request-ID')).toBe('trace-1:Ab.9_x');
    for (const bad of ['a'.repeat(65), '<script>', 'with space', '']) {
      const response = await call('/v1/status', key.key, { headers: { 'X-Request-ID': bad } });
      const id = response.headers.get('X-Request-ID')!;
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    const logs = await logsOf(key.id);
    expect(logs).toHaveLength(5);
    expect(logs.every((log) => /^[A-Za-z0-9._:-]{1,64}$/.test(log.requestId))).toBe(true);
    expect(logs.map((log) => log.requestId)).toContain('trace-1:Ab.9_x');
  });

  it('审计 path 把数字 id 归一为 :id，超长路径截断到 256 字符', async () => {
    await enableApi();
    const user = await seedUser('p0-path');
    const key = await keyFor(user.id);
    expect((await call('/v1/messages/987654321', key.key)).status).toBe(404);
    expect((await call(`/v1/messages/${'x'.repeat(2000)}`, key.key)).status).toBeGreaterThanOrEqual(400);
    const paths = (await logsOf(key.id)).map((log) => log.path);
    expect(paths).toContain('/v1/messages/:id');
    expect(paths.every((path) => path.length <= 256)).toBe(true);
    expect(paths.some((path) => path.startsWith('/v1/messages/xxx') && path.length === 256)).toBe(true);
  });

  it('已吊销的 Key 按不存在处理：401 且不写审计', async () => {
    await enableApi();
    const user = await seedUser('p0-revoked');
    const key = await keyFor(user.id);
    await createDb(env).update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, key.id));
    for (let i = 0; i < 5; i++) {
      const response = await call('/v1/status', key.key);
      expect(response.status).toBe(401);
    }
    expect(await logsOf(key.id)).toHaveLength(0);
    expect((await readCounter(env, 'api-reject', String(key.id), minuteWindow(1))).count).toBe(0);
  });

  it('禁用 Key、IP 白名单、用户停用的拒绝每 Key 每分钟只写 1 行明细，其余只累加计数', async () => {
    await enableApi();
    await awayFromMinuteBoundary();
    const db = createDb(env);
    const user = await seedUser('p0-reject');
    const disabled = await keyFor(user.id);
    await db.update(apiKeys).set({ status: 'disabled' }).where(eq(apiKeys.id, disabled.id));
    const locked = await keyFor(user.id, { allowedIps: ['203.0.113.1'] });
    const responses = await Promise.all(Array.from({ length: 6 }, () => call('/v1/status', disabled.key)));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(401));
    for (let i = 0; i < 4; i++) expect((await call('/v1/status', locked.key)).status).toBe(403);

    const disabledLogs = await logsOf(disabled.id);
    expect(disabledLogs).toHaveLength(1);
    expect(disabledLogs[0]).toMatchObject({ statusCode: 401, path: '/v1/status', ip: IP });
    expect((await readCounter(env, 'api-reject', String(disabled.id), minuteWindow(1))).count).toBe(6);
    expect(await logsOf(locked.id)).toHaveLength(1);
    expect((await readCounter(env, 'api-reject', String(locked.id), minuteWindow(1))).count).toBe(4);

    const stopped = await seedUser('p0-reject-user');
    const stoppedKey = await keyFor(stopped.id);
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, stopped.id));
    for (let i = 0; i < 3; i++) expect((await call('/v1/status', stoppedKey.key)).status).toBe(403);
    expect(await logsOf(stoppedKey.id)).toHaveLength(1);
  });

  it('Key 超限后 429 只写 1 行明细、不写 api_rate_limits；正常请求逐条记录', async () => {
    await enableApi();
    await awayFromMinuteBoundary();
    const user = await seedUser('p0-429');
    const key = await keyFor(user.id, { rateLimit: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('/v1/status', key.key)).status);
    expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
    expect(await createDb(env).select().from(apiRateLimits).where(eq(apiRateLimits.apiKeyId, key.id)).all()).toEqual([]);
    const logs = await logsOf(key.id);
    expect(logs.map((log) => log.statusCode).sort()).toEqual([200, 200, 429]);
  });
});

describe('R04 全站限流桶不被单个用户打满', () => {
  // 限流走 Rate Limiting binding：用户桶拒绝的请求不再调用全站桶，binding 被拒的调用也不计数
  it('/api 快路径：用户已超限的请求返回 429 且不进全站桶', async () => {
    const { env: target, fakes } = fakeRateLimits();
    const hot = await seedUser('p0-auth-hot');
    const calm = await seedUser('p0-auth-calm');
    fakes.rl_auth_user.fill(String(hot.id));
    const hotJwt = await jwtFor(hot.id);
    for (let i = 0; i < 5; i++) expect((await call('/api/auth/me', hotJwt, {}, target)).status).toBe(429);
    expect(fakes.rl_auth_global.calls).toEqual([]);
    expect(fakes.rl_auth_user.calls).toHaveLength(5);
    // 对照：未超限的用户照常计入全站桶
    expect((await call('/api/auth/me', await jwtFor(calm.id), {}, target)).status).toBe(200);
    expect(fakes.rl_auth_global.calls).toEqual(['instance']);
  });

  it('/api 慢路径（鉴权版本待迁移）同样不进全站桶', async () => {
    const { env: target, fakes } = fakeRateLimits();
    const hot = await seedUser('p0-auth-slow', { migrated: false });
    fakes.rl_auth_user.fill(String(hot.id));
    expect((await call('/api/auth/me', await jwtFor(hot.id), {}, target)).status).toBe(429);
    expect(fakes.rl_auth_global.calls).toEqual([]);
    const calm = await seedUser('p0-auth-slow-calm', { migrated: false });
    expect((await call('/api/auth/me', await jwtFor(calm.id), {}, target)).status).toBe(200);
    expect(fakes.rl_auth_global.calls).toEqual(['instance']);
  });

  it('/v1：用户总桶已超限的请求返回 429 且不进全站桶', async () => {
    await enableApi();
    const { env: target, fakes } = fakeRateLimits();
    const hot = await seedUser('p0-api-hot');
    const hotKey = await keyFor(hot.id);
    fakes.rl_api_user.fill(String(hot.id));
    for (let i = 0; i < 4; i++) {
      const response = await call('/v1/status', hotKey.key, {}, target);
      expect(response.status).toBe(429);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain('账户级');
    }
    expect(fakes.rl_api_global.calls).toEqual([]);
    const calm = await seedUser('p0-api-calm');
    expect((await call('/v1/status', (await keyFor(calm.id)).key, {}, target)).status).toBe(200);
    expect(fakes.rl_api_global.calls).toEqual(['instance']);
  });

  it('/v1：全站总桶超限与账户级超限给出不同的 429 文案', async () => {
    await enableApi();
    const { env: target, fakes } = fakeRateLimits();
    fakes.rl_api_global.fill('instance');
    const user = await seedUser('p0-api-global');
    const key = await keyFor(user.id);
    const response = await call('/v1/status', key.key, {}, target);
    expect(response.status).toBe(429);
    const message = ((await response.json()) as { error: { message: string } }).error.message;
    expect(message).toContain('API 总调用频率超限');
    expect(message).not.toContain('账户级');
  });
});

describe('API Key 管理的并发守卫', () => {
  it('已吊销的 Key 不能被并发的编辑改回 active', async () => {
    const user = await seedUser('p0-update-revoked');
    const key = await keyFor(user.id);
    await createDb(env).update(apiKeys).set({ status: 'disabled' }).where(eq(apiKeys.id, key.id));
    // 编辑先读到 disabled，写入前被吊销
    const racing = beforeStatement(/^update "api_keys"/i, () => revokeApiKey(env, key.id, user.id));
    await expect(updateApiKey(racing, key.id, { status: 'active' }, user.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, key.id)).get())!.status).toBe('revoked');
  });

  it('改密后仍在途的旧令牌（鉴权版本已过期）不能再创建 Key', async () => {
    const user = await seedUser('p0-create-epoch');
    const db = createDb(env);
    await db.update(users).set({ authVersion: 1 }).where(eq(users.id, user.id));
    const req = { name: 'stale', scopes: ['mail.read'] as ApiScope[], rateLimit: 120, allowedIps: [] };
    await expect(createApiKey(env, user.id, req, 0)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await db.select().from(apiKeys).where(eq(apiKeys.userId, user.id)).all()).toHaveLength(0);
    expect((await createApiKey(env, user.id, req, 1)).status).toBe('active');
  });

  it('网页创建 Key 带令牌鉴权版本，正常会话照常创建', async () => {
    const user = await seedUser('p0-create-http', { password: 'p0-create-http-pass' });
    const response = await call('/api/api-keys', await jwtFor(user.id),
      jsonInit('POST', { name: 'web', scopes: ['mail.read'], rateLimit: 60, password: 'p0-create-http-pass' }));
    expect(response.status).toBe(201);
  });
});

describe('R10 改密与重置密码吊销 API Key', () => {
  const auditsFor = (target: string) => createDb(env).select().from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.action, 'apikey.revoke_all'), eq(adminAuditLogs.target, target))).all();

  it('改密默认吊销本人全部 Key：旧 Key 401，响应带 revokedApiKeys，写审计', async () => {
    await enableApi();
    const user = await seedUser('p0-chpw', { password: 'old-password-123' });
    const other = await seedUser('p0-chpw-other');
    const first = await keyFor(user.id);
    const second = await keyFor(user.id);
    const otherKey = await keyFor(other.id);
    expect((await call('/v1/status', first.key)).status).toBe(200);
    const response = await call('/api/auth/password', await jwtFor(user.id),
      jsonInit('PUT', { oldPassword: 'old-password-123', newPassword: 'new-password-456' }));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: ChangePasswordResponse };
    expect(body.data.revokedApiKeys).toBe(2);
    expect(body.data.token).toBeTruthy();
    expect(body.data.user.id).toBe(user.id);
    for (const key of [first, second]) expect((await call('/v1/status', key.key)).status).toBe(401);
    expect((await call('/v1/status', otherKey.key)).status).toBe(200);
    expect(await auditsFor(user.username)).toHaveLength(1);
  });

  it('revokeApiKeys=false 时保留 Key；原密码错误时不吊销', async () => {
    await enableApi();
    const user = await seedUser('p0-chpw-keep', { password: 'old-password-123' });
    const key = await keyFor(user.id);
    const jwt = await jwtFor(user.id);
    expect((await call('/api/auth/password', jwt,
      jsonInit('PUT', { oldPassword: 'wrong-password-000', newPassword: 'new-password-456' }))).status).toBe(401);
    expect((await call('/v1/status', key.key)).status).toBe(200);
    const response = await call('/api/auth/password', jwt,
      jsonInit('PUT', { oldPassword: 'old-password-123', newPassword: 'new-password-456', revokeApiKeys: false }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: ChangePasswordResponse }).data.revokedApiKeys).toBe(0);
    expect((await call('/v1/status', key.key)).status).toBe(200);
    expect(await auditsFor(user.username)).toHaveLength(0);
  });

  it('管理员重置密码一律吊销该用户全部 Key；不改密码的编辑不吊销', async () => {
    await enableApi();
    const admin = await seedUser('p0-reset-admin', { role: 'admin' });
    const user = await seedUser('p0-reset-user');
    const key = await keyFor(user.id);
    const adminJwt = await jwtFor(admin.id);
    expect((await call(`/api/admin/users/${user.id}`, adminJwt, jsonInit('PUT', { role: 'user' }))).status).toBe(200);
    expect((await call('/v1/status', key.key)).status).toBe(200);
    expect((await call(`/api/admin/users/${user.id}`, adminJwt, jsonInit('PUT', { password: 'reset-password-789' }))).status).toBe(200);
    expect((await call('/v1/status', key.key)).status).toBe(401);
    expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, key.id)).get())!.status).toBe('revoked');
    const audits = await auditsFor(user.username);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin.id);
  });

  it('吊销语句以新密码哈希为守卫：密码更新未生效时不吊销', async () => {
    const user = await seedUser('p0-revoke-guard');
    const key = await keyFor(user.id);
    const db = createDb(env);
    const [revoked] = await db.batch([revokeAllApiKeysQuery(db, user.id, 'not-the-current-hash')]);
    expect(revoked).toHaveLength(0);
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get())!.status).toBe('active');
  });
});

describe('X02 通知载荷随邮件删除与任务终态清空', () => {
  async function inbound(address: string) {
    const [row] = await createDb(env).insert(messages).values({ direction: 'inbound', address, domain: 'hpc.email',
      fromAddress: 'sender@example.net', subject: 'secret subject 482913', preview: 'secret', status: 'received' })
      .returning({ id: messages.id });
    return row!.id;
  }
  const notify = (userId: number, id: number, address: string) => enqueueMailNotifications(env, null, { ownerIds: [userId],
    message: { id, address, fromAddress: 'sender@example.net', fromName: 'Sender', subject: 'secret subject 482913',
      verificationCode: '482913', preview: 'secret', createdAt: new Date().toISOString() }, text: 'secret body 482913' });
  const jobOf = (id: number) => createDb(env).select().from(notificationJobs).where(eq(notificationJobs.id, id)).get();

  it('永久删除邮件在同一批次清空通知载荷，待推送任务随后跳过、不再外发', async () => {
    const user = await seedUser('p0-purge');
    await updateUserNotifyPrefs(env, user.id, { webhook });
    const address = `p0-purge-${rand()}@hpc.email`;
    const id = await inbound(address);
    const [jobId] = await notify(user.id, id, address);
    expect(JSON.stringify((await jobOf(jobId!))!.payload)).toContain('482913');
    expect(await purgeMatchingMessages(env, sql`${messages.id} = ${id}`)).toBe(1);
    expect((await jobOf(jobId!))!.payload).toEqual({});
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await processNotificationJobs(env, { jobIds: [jobId!] })).toMatchObject({ skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const skipped = await jobOf(jobId!);
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.payload).toEqual({});
  });

  it('按 dedupe_key 前缀清空时不误清 id 前缀相同或相邻的其他邮件', async () => {
    const user = await seedUser('p0-purge-prefix');
    await updateUserNotifyPrefs(env, user.id, { webhook });
    const base = 8_800_000 + Math.floor(Math.random() * 100_000);
    const ids = [base, base * 10 + 3, base + 1];
    const jobs: number[] = [];
    for (const id of ids) {
      const address = `p0-prefix-${id}@hpc.email`;
      await createDb(env).insert(messages).values({ id, direction: 'inbound', address, domain: 'hpc.email',
        fromAddress: 'sender@example.net', subject: 'secret subject 482913', preview: 'secret', status: 'received' });
      jobs.push((await notify(user.id, id, address))[0]!);
    }
    expect(await purgeMatchingMessages(env, sql`${messages.id} = ${base}`)).toBe(1);
    expect((await jobOf(jobs[0]!))!.payload).toEqual({});
    for (const job of jobs.slice(1)) expect(JSON.stringify((await jobOf(job))!.payload)).toContain('482913');
  });

  it('推送成功清空载荷；失败保留载荷供重试', async () => {
    const user = await seedUser('p0-terminal');
    await updateUserNotifyPrefs(env, user.id, { webhook });
    const okAddress = `p0-ok-${rand()}@hpc.email`;
    const [okJob] = await notify(user.id, await inbound(okAddress), okAddress);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    await processNotificationJobs(env, { jobIds: [okJob!] });
    const succeeded = await jobOf(okJob!);
    expect(succeeded!.status).toBe('succeeded');
    expect(succeeded!.payload).toEqual({});

    const failAddress = `p0-fail-${rand()}@hpc.email`;
    const [failJob] = await notify(user.id, await inbound(failAddress), failAddress);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await processNotificationJobs(env, { jobIds: [failJob!] });
    const failed = await jobOf(failJob!);
    expect(failed!.status).toBe('failed');
    expect(JSON.stringify(failed!.payload)).toContain('secret body 482913');
  });

  it('源邮件已不存在时手动重试拒绝推送，任务转为 skipped 并清空载荷', async () => {
    const user = await seedUser('p0-retry-gone');
    await updateUserNotifyPrefs(env, user.id, { webhook });
    const address = `p0-gone-${rand()}@hpc.email`;
    const id = await inbound(address);
    const [jobId] = await notify(user.id, id, address);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await processNotificationJobs(env, { jobIds: [jobId!] });
    // 模拟升级前已删除源邮件、载荷未清空的历史任务
    await createDb(env).delete(messages).where(eq(messages.id, id));
    expect(JSON.stringify((await jobOf(jobId!))!.payload)).toContain('482913');
    await expect(retryNotificationJob(env, user.id, jobId!)).rejects.toMatchObject({ code: 'not_found' });
    const skipped = await jobOf(jobId!);
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.payload).toEqual({});
  });
});

describe('R22 幂等发信可以安全重试', () => {
  const request = (subject: string) => ({ to: ['to@example.com'], subject });
  const actor = () => ({ type: 'api_key' as const, id: 990000 + Math.floor(Math.random() * 9000) });
  const recordOf = (handle: IdempotencyHandle) => createDb(env).select().from(idempotencyRecords).where(and(
    eq(idempotencyRecords.actorType, handle.actor.type), eq(idempotencyRecords.actorId, handle.actor.id),
    eq(idempotencyRecords.key, handle.key))).get();
  async function owner(who: IdempotencyActor, key: string, body: unknown): Promise<IdempotencyHandle> {
    const start = await beginIdempotentSend(env, who, key, body);
    if (start.kind !== 'owner' || !start.handle) throw new Error('expected owner');
    return start.handle;
  }
  async function outboundRow(subject: string) {
    const [row] = await createDb(env).insert(messages).values({ direction: 'outbound', address: 'p0-out@hpc.email',
      domain: 'hpc.email', fromAddress: 'p0-out@hpc.email', subject, preview: '', status: 'pending' }).returning();
    return row!;
  }

  it('三种 409 拆码：内容不一致 idempotency_mismatch，处理中 send_in_progress', async () => {
    const who = actor();
    const key = `p0-codes-${rand()}`;
    await owner(who, key, request('a'));
    await expect(beginIdempotentSend(env, who, key, request('b'))).rejects.toMatchObject({ code: 'idempotency_mismatch' });
    await expect(beginIdempotentSend(env, who, key, request('a'))).rejects.toMatchObject({ code: 'send_in_progress' });
  });

  it('已绑定且发件行仍 pending 时返回 send_in_progress，失败也不收回', async () => {
    const who = actor();
    const key = `p0-linked-${rand()}`;
    const handle = await owner(who, key, request('linked'));
    const row = await outboundRow('linked');
    await bindIdempotentSend(env, handle, row.id);
    await failIdempotentSend(env, handle, new Error('外发结果不明'));
    expect(await recordOf(handle)).toMatchObject({ status: 'pending', messageId: row.id });
    await expect(beginIdempotentSend(env, who, key, request('linked'))).rejects.toMatchObject({ code: 'send_in_progress' });
  });

  it('5xx 失败标 failed，同 Key 同内容并发重试只有一个请求原子收回', async () => {
    const who = actor();
    const key = `p0-reclaim-${rand()}`;
    const handle = await owner(who, key, request('reclaim'));
    await failIdempotentSend(env, handle, new AppError('internal', 'D1 暂不可用'));
    expect(await recordOf(handle)).toMatchObject({ status: 'failed', messageId: null });
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => beginIdempotentSend(env, who, key, request('reclaim'))));
    const owners = attempts.filter((result) => result.status === 'fulfilled' && result.value.kind === 'owner');
    expect(owners).toHaveLength(1);
    const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(9);
    expect(rejected.every((result) => (result.reason as AppError).code === 'send_in_progress')).toBe(true);
    expect(await recordOf(handle)).toMatchObject({ status: 'pending', errorDetail: '' });
  });

  it('外发前的 4xx 删除记录，修正内容后可用同一 Key 发送', async () => {
    const who = actor();
    const key = `p0-4xx-${rand()}`;
    const handle = await owner(who, key, request('bad'));
    await failIdempotentSend(env, handle, new AppError('forbidden', '只能使用自己认领的地址发件'));
    expect(await recordOf(handle)).toBeUndefined();
    const fixed = await owner(who, key, request('fixed'));
    await completeIdempotentSend(env, fixed, { id: 1 } as never);
    expect((await recordOf(fixed))!.status).toBe('completed');
  });

  it('绑定失败把发件行标为 failed 并返回 send_in_progress，随后的失败处理不动别人的记录', async () => {
    const who = actor();
    const key = `p0-bind-${rand()}`;
    const handle = await owner(who, key, request('bind'));
    // 记录已不归本请求所有（例如已完成），绑定必然失败
    await completeIdempotentSend(env, handle, { id: 1 } as never);
    const row = await outboundRow('bind');
    const error = await bindIdempotentSend(env, handle, row.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'send_in_progress' });
    expect(await createDb(env).select().from(messages).where(eq(messages.id, row.id)).get())
      .toMatchObject({ status: 'failed' });
    await failIdempotentSend(env, handle, error);
    expect(await recordOf(handle)).toMatchObject({ status: 'completed' });
    // 幂等自身的 409 说明记录归别的请求所有：即使记录仍是 pending，也不删除、不标失败
    const held = await owner(who, `p0-held-${rand()}`, request('held'));
    await failIdempotentSend(env, held, new AppError('send_in_progress', 'x'));
    await failIdempotentSend(env, held, new AppError('idempotency_mismatch', 'x'));
    expect(await recordOf(held)).toMatchObject({ status: 'pending' });

    // 绑定成功时发件行保持 pending，记录指向它
    const fresh = await owner(who, `p0-bind-ok-${rand()}`, request('bind-ok'));
    const okRow = await outboundRow('bind-ok');
    await bindIdempotentSend(env, fresh, okRow.id);
    expect(await recordOf(fresh)).toMatchObject({ status: 'pending', messageId: okRow.id });
    expect((await createDb(env).select().from(messages).where(eq(messages.id, okRow.id)).get())!.status).toBe('pending');
  });

  it('收回 3 天前的 failed 记录并完成后，每日维护不删除，同 Key 仍重放原结果', async () => {
    const who = actor();
    const key = `p0-aged-${rand()}`;
    const handle = await owner(who, key, request('aged'));
    await failIdempotentSend(env, handle, new AppError('internal', 'D1 暂不可用'));
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await createDb(env).update(idempotencyRecords).set({ createdAt: old, updatedAt: old }).where(and(
      eq(idempotencyRecords.actorType, who.type), eq(idempotencyRecords.actorId, who.id), eq(idempotencyRecords.key, key)));
    const reclaimed = await owner(who, key, request('aged'));
    await completeIdempotentSend(env, reclaimed, { id: 424242 } as never);
    // 维护会顺带处理同文件前面用例留下的待推送通知，拦下外部请求
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    await runScheduled(env);
    const replay = await beginIdempotentSend(env, who, key, request('aged'));
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.response.id).toBe(424242);
  });

  it('绑定幂等键的 batch 抛 D1 异常时，未外发的发件行标为 failed，不留永久 pending', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
      code_extract: { enabled: false, aiEnabled: false },
      quota: { dailyOutbound: 0, dailyRecipients: 0 },
    });
    const user = await seedUser('p0-bind-throw');
    const local = `p0-bind-throw-${rand()}`;
    await createDb(env).insert(mailboxes).values({ address: `${local}@hpc.email`, domain: 'hpc.email', userId: user.id });
    const subject = `p0 bind throw ${rand()}`;
    const req = { from: { localPart: local, domain: 'hpc.email' }, to: [`p0-rcpt-${rand()}@hpc.email`], cc: [], bcc: [], subject, text: 'hi' };
    const who = { type: 'user' as const, id: user.id };
    const handle = await owner(who, `p0-bind-throw-${rand()}`, req);
    // 含幂等绑定语句的 batch 整体失败（D1 事务回滚、抛异常）
    const binding = new WeakSet<object>();
    const faulty = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const statement = target.prepare(query);
        if (/^update "idempotency_records"/i.test(query)) {
          binding.add(statement);
          const bind = statement.bind.bind(statement);
          statement.bind = (...args: unknown[]) => { const bound = bind(...args); binding.add(bound); return bound; };
        }
        return statement;
      };
      if (property === 'batch') return async (list: D1PreparedStatement[]) => {
        if (list.some((statement) => binding.has(statement))) throw new Error('injected D1 failure');
        return target.batch(list);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    await expect(sendMail(faulty, { waitUntil: () => {} }, { userId: user.id, role: 'user' }, req, [], 'https://hpc.email', handle))
      .rejects.toThrow('injected D1 failure');
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, subject)).get();
    expect(row).toMatchObject({ direction: 'outbound', status: 'failed' });
    expect(row!.errorDetail).toContain('injected D1 failure');
    expect(await recordOf(handle)).toMatchObject({ status: 'pending', messageId: null });
  });

  it('/api 发信：403 后认领发件地址，用同一 Key、同一内容重试成功', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
      code_extract: { enabled: false, aiEnabled: false },
      quota: { dailyOutbound: 0, dailyRecipients: 0 },
    });
    // 站内投递会顺带处理队列里所有待推送通知（含前面用例留下的），拦下外部请求
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const user = await seedUser('p0-send');
    const jwt = await jwtFor(user.id);
    const local = `p0-send-${rand()}`;
    const body = { from: { localPart: local, domain: 'hpc.email' }, to: [`p0-rcpt-${rand()}@hpc.email`],
      cc: [], bcc: [], subject: 'phase0 retry', text: 'hello' };
    const headers = { 'Idempotency-Key': `p0-e2e-${rand()}` };
    const first = await call('/api/messages/send', jwt, jsonInit('POST', body, headers));
    expect(first.status).toBe(403);
    await createDb(env).insert(mailboxes).values({ address: `${local}@hpc.email`, domain: 'hpc.email', userId: user.id });
    const second = await call('/api/messages/send', jwt, jsonInit('POST', body, headers));
    expect(second.status).toBe(201);
    const sent = (await second.json()) as { data: { id: number; status: string } };
    expect(sent.data.status).toBe('delivered');
    const replay = await call('/api/messages/send', jwt, jsonInit('POST', body, headers));
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { data: { id: number } }).data.id).toBe(sent.data.id);
    const changed = await call('/api/messages/send', jwt, jsonInit('POST', { ...body, subject: 'other' }, headers));
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: { code: string } }).error.code).toBe('idempotency_mismatch');
  });
});
