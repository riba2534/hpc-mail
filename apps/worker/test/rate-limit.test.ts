import {
  MAX_API_USER_REQUESTS_PER_MINUTE,
  MAX_AUTH_USER_REQUESTS_PER_MINUTE,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { apiKeys, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import {
  API_KEY_LIMIT_TIERS,
  RATE_LIMIT_BINDINGS,
  apiKeySlots,
  limitApiKeyRequest,
  limitSessionRequest,
  resetMemoryRateLimits,
} from '../src/services/rate-limit.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import { fakeRateLimits } from './fake-rate-limits.js';
import wranglerToml from '../wrangler.toml?raw';
import wranglerTestToml from '../wrangler.test.toml?raw';

const app = createApp();
const IP = '198.51.100.61';

beforeEach(async () => {
  resetMemoryRateLimits();
  await updateSettings(env, { api: { enabled: true }, security: { require2fa: false } });
});
afterEach(() => { vi.restoreAllMocks(); });

const rand = () => crypto.randomUUID().slice(0, 8);

async function seedUser(name: string, opts: { migrated?: boolean } = {}) {
  const [row] = await createDb(env).insert(users).values({
    username: `${name}-${rand()}`, passwordHash: 'x', role: 'user', status: 'active',
    authVersionMigrated: opts.migrated ?? true,
  }).returning({ id: users.id });
  return row!.id;
}

async function jwtFor(userId: number) {
  const sid = await createSession(env, userId);
  return signToken(env.jwt_secret, { sub: userId, sid, epoch: 0, uepoch: 0 });
}

async function keyFor(userId: number, rateLimit = 120) {
  return createApiKey(env, userId, { name: `rl-${rand()}`, scopes: ['mail.read'], rateLimit, allowedIps: [] });
}

async function call(path: string, token: string, target: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': IP } }, target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const messageOf = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;

/** 按分钟计的断言在窗口边界附近会跨格，离整分钟不足 5 秒时等到下一分钟 */
async function awayFromMinuteBoundary(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

describe('配置与 Key 档位', () => {
  it('wrangler.toml 的 [[ratelimits]] 与代码逐条一致：上限、60 秒周期、namespace_id 互不相同；测试配置不带 binding', () => {
    const source = wranglerToml as string;
    const blocks = [...source.matchAll(
      /\[\[ratelimits\]\]\nname = "([^"]+)"\nnamespace_id = "([^"]+)"\nsimple = \{ limit = (\d+), period = (\d+) \}/g,
    )].map(([, name, namespaceId, limit, period]) => ({ name: name!, namespaceId: namespaceId!, limit: Number(limit), period: Number(period) }));
    // 每个 [[ratelimits]] 都按上面的格式解析到，不会漏掉写法不同的块
    expect(blocks).toHaveLength(source.match(/^\[\[ratelimits\]\]$/gm)!.length);
    expect(Object.fromEntries(blocks.map((block) => [block.name, block.limit]))).toEqual(RATE_LIMIT_BINDINGS);
    expect(blocks.every((block) => block.period === 60)).toBe(true);
    expect(blocks.every((block) => /^[1-9]\d*$/.test(block.namespaceId))).toBe(true);
    expect(new Set(blocks.map((block) => block.namespaceId)).size).toBe(blocks.length);
    expect(wranglerTestToml as string).not.toMatch(/^\[\[ratelimits\]\]/m);
  });

  it('Key 上限拆成 1-2-5 档位之和：常用值只占 1–2 档，超过用户上限的部分不拆', () => {
    const tiers = (rateLimit: number) => apiKeySlots(7, rateLimit).map((slot) => slot.tier);
    expect(tiers(120)).toEqual([100, 20]);
    expect(tiers(600)).toEqual([500, 100]);
    expect(tiers(60)).toEqual([50, 10]);
    expect(tiers(1)).toEqual([1]);
    expect(tiers(7)).toEqual([5, 2]);
    expect(apiKeySlots(7, 4)).toEqual([
      { binding: 'rl_api_key_2', tier: 2, key: '7:0' },
      { binding: 'rl_api_key_2', tier: 2, key: '7:1' },
    ]);
    expect(tiers(10_000).reduce((sum, tier) => sum + tier, 0)).toBe(MAX_API_USER_REQUESTS_PER_MINUTE);
    for (let rateLimit = 1; rateLimit <= MAX_API_USER_REQUESTS_PER_MINUTE; rateLimit++) {
      const slots = apiKeySlots(7, rateLimit);
      expect(slots.reduce((sum, slot) => sum + slot.tier, 0)).toBe(rateLimit);
      expect(slots.length).toBeLessThanOrEqual(10);
      expect(slots.every((slot) => RATE_LIMIT_BINDINGS[slot.binding] === slot.tier)).toBe(true);
      expect(new Set(slots.map((slot) => `${slot.binding}/${slot.key}`)).size).toBe(slots.length);
    }
    expect([...API_KEY_LIMIT_TIERS].sort((a, b) => b - a)).toEqual([...API_KEY_LIMIT_TIERS]);
  });
});

describe('真实 Rate Limiting binding（miniflare）', () => {
  it('limit({key}) 返回 {success}，被拒的调用不计数，key 之间互不影响；按档位依次尝试', async () => {
    await awayFromMinuteBoundary();
    const probe = env.TEST_RATE_LIMIT_2;
    const key = `probe-${rand()}`;
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push((await probe.limit({ key })).success);
    expect(outcomes).toEqual([true, true, false, false]);
    expect(await probe.limit({ key: `${key}-other` })).toEqual({ success: true });

    // 真实 binding 装进档位：上限 3 = 2 + 1，第 4 次被 Key 级拒绝
    const { env: target, fakes } = fakeRateLimits({}, { ...env, rl_api_key_2: env.TEST_RATE_LIMIT_2, rl_api_key_1: env.TEST_RATE_LIMIT_1 } as Env);
    const apiKey = { id: 900_000 + Math.floor(Math.random() * 99_999), userId: 1, rateLimit: 3 };
    const verdicts = [];
    for (let i = 0; i < 4; i++) verdicts.push((await limitApiKeyRequest(target, apiKey)).rejectedBy);
    expect(verdicts).toEqual([null, null, null, 'key']);
    expect(fakes.rl_api_user.calls).toHaveLength(3);
  });
});

describe('进程内替身（binding 缺失时）', () => {
  it('/api 用户桶按用户隔离：一个用户用满后只拒绝他自己', async () => {
    const hot = 1_000_001;
    for (let i = 0; i < MAX_AUTH_USER_REQUESTS_PER_MINUTE; i++) expect(await limitSessionRequest(env, hot)).toBeNull();
    expect(await limitSessionRequest(env, hot)).toBe('user');
    expect(await limitSessionRequest(env, hot + 1)).toBeNull();
  });

  it('/v1 Key 档位：上限 3 的 Key 放行 3 次后 429，X-RateLimit 头给出近似剩余与下一分钟', async () => {
    await awayFromMinuteBoundary();
    const userId = await seedUser('rl-mem-key');
    const key = await keyFor(userId, 3);
    const statuses: number[] = [];
    const remaining: (string | null)[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await call('/v1/status', key.key);
      statuses.push(last.status);
      remaining.push(last.headers.get('X-RateLimit-Remaining'));
      expect(last.headers.get('X-RateLimit-Limit')).toBe('3');
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(remaining).toEqual(['2', '1', '0', '0']);
    expect(await messageOf(last!)).toBe('API 调用频率超限');
    expect(Number(last!.headers.get('X-RateLimit-Reset'))).toBe((Math.floor(Date.now() / 60_000) + 1) * 60);
  });
});

describe('/api（JWT）限流（用户桶拒绝不进全站桶见 phase0-security 的 R04）', () => {
  it('全站桶满时 429（已过用户桶的这一次照常计入用户桶）', async () => {
    const { env: target, fakes } = fakeRateLimits();
    const user = await seedUser('rl-auth-global');
    fakes.rl_auth_global.fill('instance');
    expect((await call('/api/auth/me', await jwtFor(user), target)).status).toBe(429);
    expect(fakes.rl_auth_user.counts.get(String(user))).toBe(1);
  });

  it('失效会话、禁用账号、无效令牌不调用限流', async () => {
    const { env: target, fakes } = fakeRateLimits();
    const id = await seedUser('rl-auth-invalid');
    const jwt = await jwtFor(id);
    await createDb(env).update(users).set({ status: 'disabled' }).where(eq(users.id, id));
    expect((await call('/api/auth/me', jwt, target)).status).toBe(403);
    await createDb(env).update(users).set({ status: 'active', authVersion: 1 }).where(eq(users.id, id));
    expect((await call('/api/auth/me', jwt, target)).status).toBe(401);
    expect((await call('/api/auth/me', 'not-a-jwt', target)).status).toBe(401);
    expect(fakes.rl_auth_user.calls).toEqual([]);
    expect(fakes.rl_auth_global.calls).toEqual([]);
  });

  it('binding 出错时放行并记日志（限流服务故障不让全站失败）', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { limit: () => Promise.reject(new Error('limiter down')) } as unknown as RateLimit;
    const { env: target } = fakeRateLimits();
    const id = await seedUser('rl-auth-broken');
    expect((await call('/api/auth/me', await jwtFor(id), { ...target, rl_auth_user: broken } as Env)).status).toBe(200);
    expect(errors.mock.calls.some(([line]) => String(line).includes('rl_auth_user'))).toBe(true);
  });
});

describe('/v1（API Key）限流', () => {
  it('Key 级超限：不调用用户桶与全站桶，也不刷新 last_used', async () => {
    const { env: target, fakes } = fakeRateLimits();
    const userId = await seedUser('rl-key-limit');
    const key = await keyFor(userId, 1);
    expect((await call('/v1/status', key.key, target)).status).toBe(200);
    await createDb(env).update(apiKeys).set({ lastUsedAt: new Date(0) }).where(eq(apiKeys.id, key.id));
    const limited = await call('/v1/status', key.key, target);
    expect(limited.status).toBe(429);
    expect(await messageOf(limited)).toBe('API 调用频率超限');
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(fakes.rl_api_key_1.calls).toEqual([`${key.id}:0`, `${key.id}:0`]);
    expect(fakes.rl_api_user.calls).toEqual([String(userId)]);
    expect(fakes.rl_api_global.calls).toEqual(['instance']);
    expect((await createDb(env).select().from(apiKeys).where(eq(apiKeys.id, key.id)).get())!.lastUsedAt!.getTime()).toBe(0);
  });

  it('同一用户的多把 Key 共用账户级上限：换 Key 不能放大额度，超限请求不计入全站', async () => {
    const { env: target, fakes } = fakeRateLimits({ rl_api_user: 3 });
    const userId = await seedUser('rl-user-limit');
    const [first, second] = [await keyFor(userId), await keyFor(userId)];
    const statuses = [];
    for (const key of [first, second, first, second, first]) statuses.push((await call('/v1/status', key.key, target)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await call('/v1/status', second.key, target);
    expect(await messageOf(limited)).toContain('账户级');
    expect(fakes.rl_api_global.calls).toHaveLength(3);
    // 另一个用户不受影响
    expect((await call('/v1/status', (await keyFor(await seedUser('rl-user-calm'))).key, target)).status).toBe(200);
  });

  it('热路径不为限流写 D1：放行的请求只读 key，last_used 未到期时不发写语句', async () => {
    const { env: base } = fakeRateLimits();
    const key = await keyFor(await seedUser('rl-no-write'));
    expect((await call('/v1/status', key.key, base)).status).toBe(200); // 首次请求写 last_used
    const statements: string[] = [];
    const db = new Proxy(env.db, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => { statements.push(query); return target.prepare(query); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await call('/v1/status', key.key, { ...base, db } as Env)).status).toBe(200);
    const writes = statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
    expect(writes.every((sql) => sql.includes('api_request_logs'))).toBe(true);
    expect(statements.some((sql) => /rate_counters|api_rate_limits/.test(sql))).toBe(false);
  });
});
