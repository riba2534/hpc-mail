import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApiKeyRequestSchema, type AdminUser, type UserMailboxPolicy } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { claimMailbox, transferMailbox } from '../src/services/mailbox.js';
import { replaceMailboxShares } from '../src/services/mailbox-share.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { updateUser } from '../src/services/user.js';
import type { Env } from '../src/types.js';
import { grantLegacyAdminScope, USER_SCOPES } from './key-helpers.js';

const app = createApp();
const db = createDb(env);
const publicDomain = 'public.policy.test';
const privateDomain = 'private.policy.test';
const secondDomain = 'second.policy.test';
const policy = (total = 0, domainLimit = 0): UserMailboxPolicy => ({ perUserLimit: total,
  domains: [{ domain: privateDomain, perUserLimit: domainLimit }, { domain: secondDomain, perUserLimit: 0 }] });

async function fixture() {
  const prefix = `policy-${crypto.randomUUID().slice(0, 8)}`;
  await updateSettings(env, {
    domains: { list: [
      { domain: publicDomain, public: true, perUserLimit: 1 },
      { domain: privateDomain, public: false, perUserLimit: 1 },
      { domain: secondDomain, public: false, perUserLimit: 1 },
    ] },
    mailbox_policy: { perUserLimit: 1, reservedLocalParts: ['admin', 'support'] },
    code_extract: { enabled: false, aiEnabled: false }, quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function account(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, passwordHash: 'test-only', role,
      authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    const key = await createApiKey(env, user.id, createApiKeyRequestSchema.parse({ name: 'policy-tests', scopes: USER_SCOPES, rateLimit: 600, password: 'unused' }));
    // 管理员沿用存量 Key 的形态（迁移 0022 自动加上 admin scope）
    if (role === 'admin') await grantLegacyAdminScope(env, key.id);
    return { ...user, jwt, key: key.key };
  }
  const admin = await account('admin', 'admin');
  const user = await account('user');
  const other = await account('other');
  const set = async (value: UserMailboxPolicy | null, id = user.id) => {
    const current = (await db.select().from(users).where(eq(users.id, id)).get())!;
    return updateUser(env, admin.id, id, { mailboxPolicy: value, expectedMailboxPolicyRevision: current.mailboxPolicyRevision });
  };
  const box = async (ownerId: number, domain = privateDomain, localPart = `${prefix}-${crypto.randomUUID().slice(0, 8)}`) =>
    (await db.insert(mailboxes).values({ userId: ownerId, domain, address: `${localPart}@${domain}` }).returning().get())!;
  return { admin, user, other, set, box, prefix };
}
async function request(path: string, token: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
function beforeWrite(pattern: RegExp | 'batch', hook: () => Promise<void>): Env {
  let triggered = false;
  const run = async () => { if (!triggered) { triggered = true; await hook(); } };
  const wrap = (statement: D1PreparedStatement, intercept: boolean): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), intercept);
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (intercept && ['first', 'all', 'run', 'raw'].includes(String(property))) await run();
        return method.apply(target, args);
      };
    },
  });
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch' && pattern === 'batch') return async (statements: D1PreparedStatement[]) => { await run(); return target.batch(statements); };
    if (property === 'prepare' && pattern !== 'batch') return (query: string) => wrap(target.prepare(query), pattern.test(query));
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) } as Env;
}

// 每个用例显式设置公共规则，所有身份均通过真实 JWT/Key 或 D1 用户权限参与校验。
describe('用户专属邮箱权限', () => {
  it('管理员设置与恢复权限会回显配置和版本、记录审计；用户和 API Key 不能修改', async () => {
    const f = await fixture();
    const body = { mailboxPolicy: policy(5, 3), expectedMailboxPolicyRevision: 0 };
    expect((await request(`/api/admin/users/${f.user.id}`, f.user.jwt, 'PUT', body)).status).toBe(403);
    expect((await request(`/api/admin/users/${f.user.id}`, f.user.key, 'PUT', body)).status).toBe(401);
    const saved = await data<AdminUser>(await request(`/api/admin/users/${f.user.id}`, f.admin.jwt, 'PUT', body));
    expect(saved).toMatchObject({ mailboxPolicy: policy(5, 3), mailboxPolicyRevision: 1 });
    const listed = await data<AdminUser[]>(await request('/api/admin/users', f.admin.jwt));
    expect(listed.find((user) => user.id === f.user.id)?.mailboxPolicy).toEqual(policy(5, 3));
    const restored = await data<AdminUser>(await request(`/api/admin/users/${f.user.id}`, f.admin.jwt, 'PUT',
      { mailboxPolicy: null, expectedMailboxPolicyRevision: 1 }));
    expect(restored).toMatchObject({ mailboxPolicy: null, mailboxPolicyRevision: 2 });
    const audit = await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.target, f.user.username), eq(adminAuditLogs.action, 'user.update')));
    expect(audit.map((row) => row.detail).join(' ')).toContain('专属配置');
    expect(audit.map((row) => row.detail).join(' ')).toContain('公共配置');
  });

  it('拒绝不存在域名、重复域名、非法额度、缺失版本和陈旧版本', async () => {
    const f = await fixture();
    for (const mailboxPolicy of [
      { perUserLimit: -1, domains: [] },
      { perUserLimit: 1, domains: [{ domain: 'unknown.policy.test', perUserLimit: 0 }] },
      { perUserLimit: 1, domains: [{ domain: privateDomain, perUserLimit: 0 }, { domain: privateDomain.toUpperCase(), perUserLimit: 0 }] },
    ]) expect((await request(`/api/admin/users/${f.user.id}`, f.admin.jwt, 'PUT', { mailboxPolicy, expectedMailboxPolicyRevision: 0 })).status).toBe(400);
    expect((await request(`/api/admin/users/${f.user.id}`, f.admin.jwt, 'PUT', { mailboxPolicy: null })).status).toBe(400);
    await f.set(policy());
    expect((await request(`/api/admin/users/${f.user.id}`, f.admin.jwt, 'PUT', { mailboxPolicy: null, expectedMailboxPolicyRevision: 0 })).status).toBe(409);
  });

  it('并发编辑仅一个版本能成功，系统域名变更不能写入陈旧授权', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([policy(2), policy(3)].map((mailboxPolicy) => updateUser(env, f.admin.id, f.user.id,
      { mailboxPolicy, expectedMailboxPolicyRevision: 0 })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = (await db.select().from(users).where(eq(users.id, f.user.id)).get())!;
    const racing = beforeWrite(/update "users"/i, async () => { await updateSettings(env, { domains: { list: [] } }); });
    await expect(updateUser(racing, f.admin.id, f.user.id, { mailboxPolicy: policy(), expectedMailboxPolicyRevision: current.mailboxPolicyRevision }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('网页与 Key 使用同一白名单和专属额度：授权私有域、排除公共域、替代公共数量限制', async () => {
    const f = await fixture();
    await f.set(policy(3, 2));
    expect(await data<string[]>(await request('/api/domains', f.user.jwt))).toEqual([privateDomain, secondDomain]);
    expect(await data(await request('/v1/domains', f.user.key))).toEqual({ domains: [privateDomain, secondDomain] });
    expect(await data<string[]>(await request('/api/domains', f.other.jwt))).toEqual([publicDomain]);
    expect(await data(await request(`/v1/mailboxes/availability?localPart=free&domain=${publicDomain}`, f.user.key)))
      .toMatchObject({ available: false, reason: 'domain_unavailable' });
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: `${f.prefix}-1`, domain: privateDomain })).status).toBe(201);
    expect((await request('/v1/mailboxes', f.user.key, 'POST', { localPart: `${f.prefix}-2`, domain: privateDomain })).status).toBe(201);
    expect(await data(await request(`/api/mailboxes/availability?localPart=more&domain=${privateDomain}`, f.user.jwt)))
      .toMatchObject({ available: false, reason: 'domain_limit' });
    expect((await request('/v1/mailboxes', f.user.key, 'POST', { localPart: `${f.prefix}-3`, domain: secondDomain })).status).toBe(201);
    expect(await data(await request(`/v1/mailboxes/availability?localPart=more&domain=${secondDomain}`, f.user.key)))
      .toMatchObject({ available: false, reason: 'quota' });
    expect((await request('/api/mailboxes', f.other.jwt, 'POST', { localPart: `${f.prefix}-other`, domain: privateDomain })).status).toBe(403);
  });

  it('公共公开性及额度变化不覆盖专属规则，系统移除域名后不能新增认领', async () => {
    const f = await fixture();
    await f.set(policy(0, 0));
    await updateSettings(env, { mailbox_policy: { perUserLimit: 1, reservedLocalParts: ['admin'] }, domains: { list: [
      { domain: publicDomain, public: true, perUserLimit: 1 }, { domain: privateDomain, public: true, perUserLimit: 1 },
    ] } });
    expect(await data<string[]>(await request('/api/domains', f.user.jwt))).toEqual([privateDomain]);
    for (let index = 0; index < 3; index++) await claimMailbox(env, f.user.id, 'user', { localPart: `${f.prefix}-${index}`, domain: privateDomain });
    await updateSettings(env, { domains: { list: [{ domain: publicDomain, public: true, perUserLimit: 0 }] } });
    expect(await data<string[]>(await request('/api/domains', f.user.jwt))).toEqual([]);
    expect((await request('/v1/mailboxes', f.user.key, 'POST', { localPart: 'gone', domain: privateDomain })).status).toBe(400);
  });

  it('保留前缀仍受限制，管理员即使保存空专属配置也豁免', async () => {
    const f = await fixture();
    await f.set(policy());
    expect((await request('/v1/mailboxes', f.user.key, 'POST', { localPart: 'support', domain: privateDomain })).status).toBe(403);
    await f.set({ perUserLimit: 1, domains: [] }, f.admin.id);
    expect(await data<string[]>(await request('/api/domains', f.admin.jwt))).toEqual([publicDomain, privateDomain, secondDomain]);
    expect((await request('/api/mailboxes', f.admin.jwt, 'POST', { localPart: 'support', domain: privateDomain })).status).toBe(201);
  });

  it('收紧和恢复公共配置保留已有邮箱读信与两种发件身份，旧邮箱仍计入总额度', async () => {
    const f = await fixture();
    await f.set(policy());
    const box = await claimMailbox(env, f.user.id, 'user', { localPart: `${f.prefix}-kept`, domain: privateDomain });
    const message = (await db.insert(messages).values({ address: box.address, domain: privateDomain, direction: 'inbound', status: 'received', bodyText: 'kept mail' }).returning().get())!;
    await f.set({ perUserLimit: 1, domains: [] });
    expect(await data<string[]>(await request('/api/domains', f.user.jwt))).toEqual([]);
    expect((await request(`/api/messages/${message.id}`, f.user.jwt)).status).toBe(200);
    expect((await request('/api/messages/send', f.user.jwt, 'POST', { from: { mailboxId: box.id }, to: [box.address], subject: 'kept', text: 'kept' })).status).toBe(201);
    expect((await request('/v1/messages', f.user.key, 'POST', { from: { localPart: box.address.split('@')[0], domain: privateDomain }, to: [box.address], subject: 'kept again', text: 'kept' })).status).toBe(201);
    await f.set(null);
    expect(await data<string[]>(await request('/api/domains', f.user.jwt))).toEqual([publicDomain]);
    expect(await data(await request(`/v1/mailboxes/availability?localPart=more&domain=${publicDomain}`, f.user.key)))
      .toMatchObject({ available: false, reason: 'quota' });
    expect((await request(`/v1/messages/${message.id}`, f.user.key)).status).toBe(200);
  });

  it('只读共享不占认领额度，空白名单禁止新增', async () => {
    const f = await fixture();
    await f.set({ perUserLimit: 1, domains: [] });
    expect((await request('/api/mailboxes', f.user.jwt, 'POST', { localPart: `${f.prefix}-no`, domain: publicDomain })).status).toBe(403);
    const shared = await f.box(f.admin.id);
    await replaceMailboxShares(env, f.admin.id, shared.id, [f.user.id]);
    await f.set(policy(1));
    await claimMailbox(env, f.user.id, 'user', { localPart: `${f.prefix}-own`, domain: privateDomain });
    expect((await request('/api/mailboxes/shared', f.user.jwt)).status).toBe(200);
    await expect(claimMailbox(env, f.user.id, 'user', { localPart: `${f.prefix}-more`, domain: secondDomain })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(['total', 'domain'])('并发认领不能突破专属 %s 额度', async (kind) => {
    const f = await fixture();
    await f.set(policy(kind === 'total' ? 1 : 0, kind === 'domain' ? 1 : 0));
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => claimMailbox(env, f.user.id, 'user',
      { localPart: `${f.prefix}-${index}`, domain: kind === 'total' && index % 2 ? secondDomain : privateDomain })));
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it.each([false, true])('写入前收紧权限拦截旧认领：原专属配置=%s', async (custom) => {
    const f = await fixture();
    if (custom) await f.set(policy());
    const domain = custom ? privateDomain : publicDomain;
    const racing = beforeWrite(/INSERT INTO mailboxes/i, async () => { await f.set({ perUserLimit: 0, domains: [] }); });
    await expect(claimMailbox(racing, f.user.id, 'user', { localPart: `${f.prefix}-race`, domain })).rejects.toMatchObject({ code: 'conflict' });
    expect(await db.select().from(mailboxes).where(eq(mailboxes.userId, f.user.id))).toHaveLength(0);
  });

  it.each(['domain', 'total', 'per-domain', 'reserved'])('管理员过户遵守专属 %s 规则，失败保持归属、共享及审计不变', async (kind) => {
    const f = await fixture();
    await f.set(kind === 'domain' ? { perUserLimit: 0, domains: [] } : policy(kind === 'total' ? 1 : 0, kind === 'per-domain' ? 1 : 0));
    if (kind === 'total' || kind === 'per-domain') await f.box(f.user.id);
    const box = await f.box(f.admin.id, privateDomain, kind === 'reserved' ? 'admin' : undefined);
    await replaceMailboxShares(env, f.admin.id, box.id, [f.other.id]);
    const response = await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, 'POST', { userId: f.user.id, expectedOwnerId: f.admin.id });
    expect(response.status).toBe(403);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())?.userId).toBe(f.admin.id);
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
    expect(await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.target, box.address), eq(adminAuditLogs.action, 'mailbox.transfer')))).toHaveLength(0);
  });

  it('合规过户撤销共享、保留历史，额度收紧后的同目标重试仍幂等', async () => {
    const f = await fixture();
    await f.set(policy(1, 1));
    const box = await f.box(f.admin.id);
    await replaceMailboxShares(env, f.admin.id, box.id, [f.other.id]);
    const message = (await db.insert(messages).values({ address: box.address, domain: privateDomain, direction: 'inbound', status: 'received', bodyText: 'history' }).returning().get())!;
    const req = { userId: f.user.id, expectedOwnerId: f.admin.id };
    expect(await transferMailbox(env, f.admin, box.id, req)).toMatchObject({ transferred: true, revokedShares: 1 });
    await f.set({ perUserLimit: 1, domains: [] });
    expect(await transferMailbox(env, f.admin, box.id, req)).toMatchObject({ transferred: false, revokedShares: 0 });
    expect((await request(`/api/messages/${message.id}`, f.user.jwt)).status).toBe(200);
  });

  it.each(['policy', 'quota', 'domain'])('过户写入边界复核 %s 变化，失败不撤销共享', async (kind) => {
    const f = await fixture();
    await f.set(policy(1, 1));
    const box = await f.box(f.admin.id);
    await replaceMailboxShares(env, f.admin.id, box.id, [f.other.id]);
    const racing = beforeWrite('batch', async () => {
      if (kind === 'policy') await f.set({ perUserLimit: 1, domains: [] });
      if (kind === 'quota') await f.box(f.user.id);
      if (kind === 'domain') await updateSettings(env, { domains: { list: [] } });
    });
    await expect(transferMailbox(racing, f.admin, box.id, { userId: f.user.id, expectedOwnerId: f.admin.id })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())?.userId).toBe(f.admin.id);
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
  });

  it('写入前从公共切换成专属配置也不能绕过过户限制', async () => {
    const f = await fixture();
    const box = await f.box(f.admin.id);
    const racing = beforeWrite('batch', async () => { await f.set({ perUserLimit: 0, domains: [] }); });
    await expect(transferMailbox(racing, f.admin, box.id, { userId: f.user.id, expectedOwnerId: f.admin.id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('损坏的专属配置不能回落公共权限', async () => {
    const f = await fixture();
    await env.db.prepare('UPDATE users SET mailbox_policy = ? WHERE id = ?').bind(JSON.stringify({ perUserLimit: -1, domains: [] }), f.user.id).run();
    expect((await request('/api/domains', f.user.jwt)).status).toBe(500);
    await expect(claimMailbox(env, f.user.id, 'user', { localPart: `${f.prefix}-corrupt`, domain: publicDomain })).rejects.toMatchObject({ code: 'internal' });
  });
});
