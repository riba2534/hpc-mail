import { DEFAULT_SETTINGS } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { sessions, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';
import { createApiKey } from '../src/services/api-key.js';
import { loadMailboxPolicyUser, resolveMailboxPolicy } from '../src/services/mailbox-policy.js';
import { createSession } from '../src/services/session.js';
import {
  getSettings,
  getSettingsFresh,
  invalidateSettingsMemory,
  settingsQuery,
  updateSettings,
} from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); });

type KvMethod = 'get' | 'put' | 'delete';
interface D1Call { kind: 'single' | 'batch'; sql: string[] }

/**
 * 记录 D1 往返与 KV 调用：每次 first/all/run/raw 或 batch 记一次往返；
 * 往返开始时若没有其他 D1 请求在途则记为新的一层串行，用来区分「并行」与「串行」。
 * 结果返回前多等 2ms，让真正并行的请求必然重叠，串行请求不受影响。
 */
function tracedEnv(kvOverrides: Partial<Record<KvMethod, (...args: unknown[]) => Promise<unknown>>> = {}) {
  const calls: D1Call[] = [];
  const kvCalls: string[] = [];
  let inFlight = 0;
  let layers = 0;
  const statements = new WeakMap<object, { real: D1PreparedStatement; sql: string }>();
  const track = <T>(call: D1Call, run: () => Promise<T>): Promise<T> => {
    calls.push(call);
    if (inFlight === 0) layers++;
    inFlight++;
    return run()
      .then(async (value) => { await new Promise((resolve) => setTimeout(resolve, 2)); return value; })
      .finally(() => { inFlight--; });
  };
  const wrap = (real: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === 'first' || property === 'all' || property === 'run' || property === 'raw') {
          return (...args: unknown[]) => track({ kind: 'single', sql: [sql] },
            () => (target[property] as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { real, sql });
    return proxy;
  };
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch') {
        return (list: D1PreparedStatement[]) => track(
          { kind: 'batch', sql: list.map((s) => statements.get(s)?.sql ?? '?') },
          () => target.batch(list.map((s) => statements.get(s)?.real ?? s)),
        );
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const kv = new Proxy(env.kv, {
    get(target, property) {
      if (property === 'get' || property === 'put' || property === 'delete' || property === 'list' || property === 'getWithMetadata') {
        return (...args: unknown[]) => {
          kvCalls.push(`${String(property)}:${String(args[0] ?? '')}`);
          const override = kvOverrides[property as KvMethod];
          return override ? override(...args) : (target[property] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    env: { ...env, db, kv } as Env,
    calls,
    kvCalls,
    layers: () => layers,
    reset() { calls.length = 0; kvCalls.length = 0; layers = 0; },
  };
}

/** 收集 waitUntil 的执行上下文，不等待其中的任务 */
function collectingCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {}, props: {} };
  return { ctx: ctx as unknown as ExecutionContext, pending };
}


async function request(path: string, init: RequestInit, target: Env = env, ctx: ExecutionContext = createExecutionContext()) {
  const response = await app.request(path, init, target, ctx);
  return response;
}

async function seedUser(username: string, opts: { role?: 'admin' | 'user'; password?: string } = {}) {
  const [row] = await createDb(env).insert(users).values({
    username,
    passwordHash: opts.password ? await hashPassword(opts.password) : 'x',
    role: opts.role ?? 'user',
    status: 'active',
    authVersionMigrated: true,
  }).returning({ id: users.id });
  return row!.id;
}

async function jwtFor(userId: number) {
  const sid = await createSession(env, userId);
  return signToken(env.jwt_secret, { sub: userId, sid, epoch: 0, uepoch: 0 });
}

const json = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7', ...extra },
  body: JSON.stringify(body),
});
const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '198.51.100.7' } });
const isSettingsRead = (sql: string) => /FROM\s+"?settings"?/i.test(sql) && !/WHERE/i.test(sql);

describe('settings 只用 isolate 内存缓存与 D1', () => {
  it('未命中直读一次 D1，不读写 KV 的 setting-cache；命中后 0 次 D1/KV', async () => {
    invalidateSettingsMemory();
    await env.kv.put('setting-cache', JSON.stringify({ ...DEFAULT_SETTINGS, site: { ...DEFAULT_SETTINGS.site, title: 'Stale KV Title' } }));
    const traced = tracedEnv();
    const ctx = createExecutionContext();
    const first = await getSettings(traced.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(first).toEqual(await getSettingsFresh(env));
    expect(first.site.title).not.toBe('Stale KV Title');
    expect(traced.calls).toHaveLength(1);
    expect(isSettingsRead(traced.calls[0]!.sql[0]!)).toBe(true);
    expect(traced.kvCalls).toEqual([]);

    traced.reset();
    expect(await getSettings(traced.env)).toBe(first);
    expect(traced.calls).toEqual([]);
    expect(traced.kvCalls).toEqual([]);
    await env.kv.delete('setting-cache');
  });

  it('updateSettings 后同 isolate 立即可见，不读写 KV（旧版 KV 设置缓存已无读者）', async () => {
    invalidateSettingsMemory();
    const before = await getSettings(env);
    const traced = tracedEnv();
    const { ctx, pending } = collectingCtx();
    await updateSettings(traced.env, { site: { ...before.site, title: 'Perf Updated Title' } }, ctx);
    expect((await getSettings(env)).site.title).toBe('Perf Updated Title');
    await updateSettings(traced.env, { site: before.site });
    expect((await getSettings(env)).site.title).toBe(before.site.title);
    expect(traced.kvCalls).toEqual([]);
    expect(pending).toEqual([]);
  });

  it('失效前发出、失效后才返回的读取不回填缓存', async () => {
    invalidateSettingsMemory();
    const query = settingsQuery(env);
    if ('cached' in query) throw new Error('缓存应已失效');
    const result = await query.statement.all();
    invalidateSettingsMemory();
    query.resolve(result);
    const traced = tracedEnv();
    await getSettings(traced.env);
    expect(traced.calls).toHaveLength(1);
  });

  it('D1 读失败回落默认值，且不缓存默认值', async () => {
    invalidateSettingsMemory();
    const broken = {
      ...env,
      db: { prepare: () => ({ all: () => Promise.reject(new Error('D1 unavailable')) }) },
    } as unknown as Env;
    expect(await getSettings(broken)).toEqual(DEFAULT_SETTINGS);
    const traced = tracedEnv();
    expect(await getSettings(traced.env)).toEqual(await getSettingsFresh(env));
    expect(traced.calls).toHaveLength(1);
  });
});

describe('/api/config 往返', () => {
  it('冷 isolate 1 次 D1，热 isolate 0 次 D1/KV', async () => {
    invalidateSettingsMemory();
    const traced = tracedEnv();
    expect((await request('/api/config', {}, traced.env)).status).toBe(200);
    expect(traced.calls).toHaveLength(1);
    expect(traced.kvCalls).toEqual([]);
    traced.reset();
    expect((await request('/api/config', {}, traced.env)).status).toBe(200);
    expect(traced.calls).toEqual([]);
    expect(traced.kvCalls).toEqual([]);
  });
});

describe('/v1 鉴权往返', () => {
  async function apiKey(username: string) {
    const id = await seedUser(username);
    return (await createApiKey(env, id, { name: username, scopes: ['mail.read'], rateLimit: 120, allowedIps: [] })).key;
  }
  /** 去掉 waitUntil 里的审计写入，只看鉴权本身的往返 */
  const authCalls = (calls: D1Call[]) => calls.filter((call) => !call.sql.some((sql) => sql.includes('api_request_logs')));

  it('冷 isolate：设置与 key 合进同一个读 batch，鉴权共 2 次串行 D1；热 isolate 不多于此', async () => {
    const key = await apiKey('perf-v1-cold');
    invalidateSettingsMemory();
    const traced = tracedEnv();
    const ctx = createExecutionContext();
    expect((await request('/v1/status', bearer(key), traced.env, ctx)).status).toBe(200);
    await waitOnExecutionContext(ctx);
    const cold = authCalls(traced.calls);
    expect(cold.map((call) => call.kind)).toEqual(['batch', 'batch']);
    expect(cold[0]!.sql).toHaveLength(2);
    expect(cold[0]!.sql.some(isSettingsRead)).toBe(true);
    expect(cold[0]!.sql.some((sql) => sql.includes('api_keys'))).toBe(true);
    expect(traced.layers()).toBe(3); // 读 batch → 写 batch → waitUntil 审计
    expect(traced.kvCalls).toEqual([]);

    traced.reset();
    const hotCtx = createExecutionContext();
    expect((await request('/v1/status', bearer(key), traced.env, hotCtx)).status).toBe(200);
    await waitOnExecutionContext(hotCtx);
    const hot = authCalls(traced.calls);
    expect(hot.map((call) => call.kind)).toEqual(['single', 'batch']);
    expect(hot[0]!.sql[0]).toContain('api_keys');
    expect(traced.layers()).toBe(3);
    expect(traced.kvCalls).toEqual([]);
  });

  it('API 关闭优先于 Key 校验；非法 Key 只读设置', async () => {
    const key = await apiKey('perf-v1-disabled');
    await updateSettings(env, { api: { enabled: false } });
    try {
      const traced = tracedEnv();
      const disabled = await request('/v1/status', bearer(key), traced.env);
      expect(disabled.status).toBe(403);
      invalidateSettingsMemory();
      const garbage = await request('/v1/status', bearer('not-a-key'), traced.env);
      expect(garbage.status).toBe(403);
    } finally {
      await updateSettings(env, { api: { enabled: true } });
    }
    invalidateSettingsMemory();
    const traced = tracedEnv();
    const garbage = await request('/v1/status', bearer('not-a-key'), traced.env);
    expect(garbage.status).toBe(401);
    expect(traced.calls).toHaveLength(1);
    expect(isSettingsRead(traced.calls[0]!.sql[0]!)).toBe(true);
  });
});

describe('会话与鉴权版本只写 D1，不碰 KV', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const claimsOf = (token: string) =>
    JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;

  it('登录只写 D1 会话行：寿命与 JWT 同为 7 天，令牌不再带 epoch，全程 0 次 KV', async () => {
    const password = 'perf-login-pass-1';
    const id = await seedUser('perf-login-d1', { password });
    const traced = tracedEnv();
    const { ctx, pending } = collectingCtx();
    const startedAt = Date.now();
    const response = await request('/api/auth/login', json({ username: 'perf-login-d1', password }), traced.env, ctx);
    expect(response.status).toBe(200);
    const { token } = ((await response.json()) as { data: { token: string } }).data;
    expect(traced.kvCalls).toEqual([]);
    expect(pending).toEqual([]);
    const claims = claimsOf(token);
    expect(claims).not.toHaveProperty('epoch');
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sid', 'sub', 'uepoch']);
    const [row] = await createDb(env).select().from(sessions).where(eq(sessions.userId, id)).all();
    const ttl = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(ttl).toBe(7 * DAY_MS);
    expect(Number(claims.exp) * 1000 - row!.expiresAt.getTime()).toBeLessThan(5000);
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
    expect((await request('/api/auth/me', bearer(token))).status).toBe(200);
  });

  it('改密与注销同样只改 D1：旧令牌立即失效，0 次 KV', async () => {
    const password = 'perf-logout-pass-1';
    const id = await seedUser('perf-logout-d1', { password });
    const login = await request('/api/auth/login', json({ username: 'perf-logout-d1', password }));
    const { token } = ((await login.json()) as { data: { token: string } }).data;

    const traced = tracedEnv();
    const changed = await request('/api/auth/password',
      { ...json({ oldPassword: password, newPassword: 'perf-logout-pass-2' }), method: 'PUT', headers: { ...json({}).headers as Record<string, string>, Authorization: `Bearer ${token}` } },
      traced.env, collectingCtx().ctx);
    expect(changed.status).toBe(200);
    expect((await createDb(env).select().from(users).where(eq(users.id, id)).get())!.authVersion).toBe(1);
    const { token: renewed } = ((await changed.json()) as { data: { token: string } }).data;
    expect((await request('/api/auth/me', bearer(token))).status).toBe(401);

    const logout = await request('/api/auth/logout', { method: 'POST', ...bearer(renewed) }, traced.env, collectingCtx().ctx);
    expect(logout.status).toBe(200);
    expect((await request('/api/auth/me', bearer(renewed))).status).toBe(401);
    expect(traced.kvCalls).toEqual([]);
  });

  it('带旧 epoch 声明的令牌（上一版本签发）仍按 sub/sid/uepoch 校验通过', async () => {
    const id = await seedUser('perf-legacy-epoch-claim');
    const sid = await createSession(env, id);
    const legacy = await signToken(env.jwt_secret, { sub: id, sid, uepoch: 0 });
    // 手工拼一个带 epoch:0 的旧令牌：签名口径与 signToken 相同
    const parts = legacy.split('.');
    const payload = { ...claimsOf(legacy), epoch: 0 };
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.jwt_secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${payloadB64}`)));
    const sigB64 = btoa(String.fromCharCode(...signature)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect((await request('/api/auth/me', bearer(`${parts[0]}.${payloadB64}.${sigB64}`))).status).toBe(200);
  });
});

describe('/api/domains 往返', () => {
  const list = [
    { domain: 'perf-pub.example', public: true, perUserLimit: 0 },
    { domain: 'perf-priv.example', public: false, perUserLimit: 0 },
  ];

  it('鉴权 batch 之后用户策略（含托管域名）与设置并行直读（最多 2 层 D1），结果与认领口径一致', async () => {
    await updateSettings(env, { domains: { list } });
    const userId = await seedUser('perf-domains-user');
    const adminId = await seedUser('perf-domains-admin', { role: 'admin' });
    const expected = async (id: number) => resolveMailboxPolicy(await getSettingsFresh(env), await loadMailboxPolicyUser(createDb(env), id))
      .domains.map(({ domain }) => domain);

    for (const [id, want] of [[userId, ['perf-pub.example']], [adminId, ['perf-pub.example', 'perf-priv.example']]] as const) {
      const token = await jwtFor(id);
      invalidateSettingsMemory();
      const traced = tracedEnv();
      const cold = await request('/api/domains', bearer(token), traced.env);
      const coldBody = ((await cold.json()) as { data: string[] }).data;
      expect(coldBody).toEqual(want);
      expect(coldBody).toEqual(await expected(id));
      expect(traced.calls.map((call) => call.kind)).toEqual(['batch', 'batch', 'single']);
      expect(traced.layers()).toBe(2);
      expect(traced.kvCalls).toEqual([]);

      traced.reset();
      const hot = await request('/api/domains', bearer(token), traced.env);
      expect(((await hot.json()) as { data: string[] }).data).toEqual(want);
      // 设置直读 D1（认领弹窗的前端闸门要立即反映域名变更），与策略读取并行，仍是 2 层
      expect(traced.calls.map((call) => call.kind)).toEqual(['batch', 'batch', 'single']);
      expect(traced.layers()).toBe(2);
    }
  });

  it('其他 isolate 更新域名（本 isolate 内存缓存未失效）后立即可见', async () => {
    const userId = await seedUser('perf-domains-other-isolate');
    const token = await jwtFor(userId);
    await updateSettings(env, { domains: { list } });
    // 预热本 isolate 的设置内存缓存
    expect(((await (await request('/api/config', {})).json()) as { data: { domains: string[] } }).data.domains).toEqual(['perf-pub.example']);
    // 模拟另一 isolate 的写入：直接改 D1，不经过本 isolate 的缓存失效
    const domains = await getSettingsFresh(env);
    await env.db.prepare(`UPDATE settings SET value = ? WHERE key = 'domains'`)
      .bind(JSON.stringify({ ...domains.domains, list: list.map((entry) => ({ ...entry, public: true })) })).run();
    expect(((await (await request('/api/domains', bearer(token))).json()) as { data: string[] }).data)
      .toEqual(['perf-pub.example', 'perf-priv.example']);
    invalidateSettingsMemory();
    await updateSettings(env, { domains: { list: [] } });
  });

  it('同 isolate 内更新域名后立即可见', async () => {
    const userId = await seedUser('perf-domains-update');
    const token = await jwtFor(userId);
    await updateSettings(env, { domains: { list } });
    expect(((await (await request('/api/domains', bearer(token))).json()) as { data: string[] }).data).toEqual(['perf-pub.example']);
    await updateSettings(env, { domains: { list: list.map((entry) => ({ ...entry, public: true })) } });
    expect(((await (await request('/api/domains', bearer(token))).json()) as { data: string[] }).data)
      .toEqual(['perf-pub.example', 'perf-priv.example']);
    await updateSettings(env, { domains: { list: [] } });
  });
});
