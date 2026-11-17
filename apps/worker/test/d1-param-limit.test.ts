import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { HostedDomainMember, Invite } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { hostedDomains, invites, storageCleanupJobs, users } from '../src/db/schema.js';
import worker from '../src/index.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';

const app = createApp();
const db = createDb(env);
const TOO_MANY = /too many SQL variables/;
const NOT_ENFORCED = '本地 D1 已不再模拟线上 100 个绑定参数上限，需要恢复测试守卫（在 setupFiles 里包装 D1 语句的 bind/执行/batch）';
const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');
const numbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

/** drizzle 把 D1 错误包成 DrizzleQueryError（message 是 Failed query…），原错误在 cause 里 */
async function expectTooMany(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error, NOT_ENFORCED).toBeInstanceOf(Error);
  expect(`${(error as Error).message} ${String((error as Error).cause)}`, NOT_ENFORCED).toMatch(TOO_MANY);
}

let sequence = 0;
async function actor(role: 'admin' | 'user' = 'user') {
  const user = (await db.insert(users).values({ username: `d1p-${++sequence}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
}

/** 一条语句批量建用户（json_each 只占 2 个参数） */
async function bulkUsers(prefix: string, count: number): Promise<number[]> {
  const { results } = await env.db.prepare(`INSERT INTO users (username, password_hash) SELECT ?1 || '-' || value, 'test' FROM json_each(?2) RETURNING id`)
    .bind(prefix, JSON.stringify(numbers(count))).all<{ id: number }>();
  return results.map((row) => row.id);
}

async function activeHostedDomain(domain: string, ownerId: number): Promise<number> {
  const [row] = await db.insert(hostedDomains).values({ domain, userId: ownerId, status: 'active', zoneId: `zone-${domain}` }).returning();
  return row!.id;
}

type Call = (method: string, path: string, token: string, body?: unknown) => Promise<Response>;
const init = (method: string, token: string, body?: unknown): RequestInit => ({ method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const viaApp: Call = async (method, path, token, body) => {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, init(method, token, body), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};
// 生产入口：index.ts 会把 env.db 再包一层计数代理
const viaWorker: Call = async (method, path, token, body) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://mail.example/api${path}`, init(method, token, body)), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};

// 哨兵：线上 D1 单条语句最多 100 个绑定参数。本地 D1 现在也按 100 拒绝（与线上同一条错误），
// 所以整套测试天然在线上上限下运行；哪天依赖升级放宽了，这里先失败
describe('本地 D1 与线上一样限制 100 个绑定参数', () => {
  it('原生语句：100 个通过，101 个执行时被拒', async () => {
    expect((await env.db.prepare(`SELECT ${placeholders(100)}`).bind(...numbers(100)).raw())[0]).toHaveLength(100);
    const over = env.db.prepare(`SELECT ${placeholders(101)}`).bind(...numbers(101));
    await expectTooMany(over.first());
    await expectTooMany(over.all());
    await expectTooMany(over.raw());
    await expectTooMany(over.run());
  });

  it('batch 里任一语句超限则整个 batch 被拒，其余语句也不写入', async () => {
    const key = 'd1p/batch-guard';
    const write = env.db.prepare('INSERT INTO storage_cleanup_jobs (r2_key) VALUES (?)').bind(key);
    await expectTooMany(env.db.batch([write, env.db.prepare(`SELECT ${placeholders(101)}`).bind(...numbers(101))]));
    expect(await db.select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, key)).get()).toBeUndefined();
  });

  it('drizzle 查询：100 个通过，101 个被拒', async () => {
    expect(db.select().from(users).where(inArray(users.id, numbers(101))).toSQL().params).toHaveLength(101);
    await db.select().from(users).where(inArray(users.id, numbers(100))).all();
    await expectTooMany(db.select().from(users).where(inArray(users.id, numbers(101))).all());
  });
});

describe('一次请求带满上限的列表不超过 D1 参数上限', () => {
  it('托管域名一次新增 100 个成员（app 与 Worker 入口）', async () => {
    const owner = await actor();
    for (const [name, call] of [['app', viaApp], ['worker', viaWorker]] as const) {
      const id = await activeHostedDomain(`d1p-${name}.test`, owner.id);
      const memberIds = await bulkUsers(`d1p-${name}`, 100);
      const response = await call('PUT', `/hosted-domains/${id}/members`, owner.jwt, { userIds: memberIds, expectedOwnerId: owner.id });
      const { data } = await response.json() as { data: HostedDomainMember[] };
      expect(response.status).toBe(200);
      expect(data.map((member) => member.userId).sort((a, b) => a - b)).toEqual(memberIds);
    }
  });

  it('新增成员里的已禁用用户在后一批里也能识别', async () => {
    const owner = await actor();
    const id = await activeHostedDomain('d1p-disabled.test', owner.id);
    const memberIds = await bulkUsers('d1p-disabled', 100);
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, memberIds[99]!));
    const response = await viaApp('PUT', `/hosted-domains/${id}/members`, owner.jwt, { userIds: memberIds, expectedOwnerId: owner.id });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('启用中');
  });

  it('管理员一次生成 50 个邀请码', async () => {
    const admin = await actor('admin');
    const response = await viaApp('POST', '/admin/invites', admin.jwt, { count: 50, maxUses: 2, note: 'd1p' });
    const { data } = await response.json() as { data: Invite[] };
    expect(response.status).toBe(201);
    expect(data).toHaveLength(50);
    expect(new Set(data.map((invite) => invite.code)).size).toBe(50);
    expect(data.every((invite) => invite.maxUses === 2 && invite.note === 'd1p' && invite.status === 'usable')).toBe(true);
    expect(await db.select().from(invites).where(eq(invites.note, 'd1p')).all()).toHaveLength(50);
  });

  it('邮件批量操作带满 500 个 id（星标走含共享的可见范围）', async () => {
    const user = await actor();
    const ids = numbers(500).map((n) => 1_000_000 + n);
    for (const [path, body] of [
      ['/messages/star', { ids, starred: true }],
      ['/messages/delete', { ids }],
      ['/messages/restore', { ids }],
      ['/messages/purge', { ids }],
    ] as const) {
      const response = await viaApp('POST', path, user.jwt, body);
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    }
  });
});
