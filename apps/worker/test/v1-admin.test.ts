import type {
  AdminClaimAndShareResult, AdminHostedDomainView, AdminMailboxBatchResult, AdminMailboxView, AdminUserView, CreatedApiKey,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { lookupAdminHostedDomains, lookupAdminMailboxes, lookupAdminUsers } from '../src/services/admin-lookup.js';
import { adminClaimAndShare, adminReplaceShares } from '../src/services/mailbox-admin-batch.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import { TEST_PASSWORD, testPasswordHash } from './key-helpers.js';
import { beforeStatement } from './support/system-domains.js';

const app = createApp();
const db = createDb(env);
const IP = '203.0.113.31';
const DOMAIN = 'v1admin.test';
const OTHER_DOMAIN = 'other.v1admin.test';
let sequence = 0;

async function request(path: string, init: RequestInit & { key?: string } = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set('CF-Connecting-IP', IP);
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`);
  const response = await app.request(path, { ...init, headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const send = (path: string, key: string, body: unknown, method = 'POST', requestId?: string) => request(path, { method, key,
  headers: { 'Content-Type': 'application/json', ...(requestId ? { 'X-Request-ID': requestId } : {}) }, body: JSON.stringify(body) });

async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string }; requestId?: string };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return { ...body.error, requestId: body.requestId };
}

async function fixture() {
  const prefix = `va-${++sequence}`;
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }, { domain: OTHER_DOMAIN, public: true, perUserLimit: 0 }] },
    mailbox_policy: { perUserLimit: 0, reservedLocalParts: ['support'] },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: await testPasswordHash(), authVersionMigrated: true })
      .returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  async function keyFor(jwt: string, body: Record<string, unknown>) {
    return data<CreatedApiKey>(await send('/api/api-keys', jwt, { name: `k-${++sequence}`, rateLimit: 600, password: TEST_PASSWORD, ...body }), 201);
  }
  const admin = await actor('admin', 'admin');
  const owner = await actor('owner');
  const target = await actor('target');
  const member = await actor('member');
  // 运维用的管理员 Key：管理员账户 + admin scope，另带读写邮箱与读信（Claude 查询）的 scope
  const adminKey = await keyFor(admin.jwt, { scopes: OPS_SCOPES });
  const address = (name: string, domain = DOMAIN) => `${prefix}-${name}@${domain}`;
  async function box(ownerId: number, name: string, domain = DOMAIN) {
    return (await db.insert(mailboxes).values({ address: address(name, domain), domain, userId: ownerId }).returning().get())!;
  }
  async function share(mailboxId: number, ...userIds: number[]) {
    await db.insert(mailboxShares).values(userIds.map((userId) => ({ mailboxId, userId, grantedBy: admin.id })));
  }
  return { prefix, actor, keyFor, admin, owner, target, member, adminKey, address, box, share };
}

const audits = (actorId: number, action: string) => db.select().from(adminAuditLogs)
  .where(and(eq(adminAuditLogs.actorId, actorId), eq(adminAuditLogs.action, action))).all();
const membersOf = async (id: number) => (await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, id)).all())
  .map((row) => row.userId).sort((a, b) => a - b);
const ownerOf = async (id: number) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())?.userId;
const sorted = (...ids: number[]) => [...ids].sort((a, b) => a - b);
const OPS_SCOPES = ['mail.read', 'mailbox.read', 'mailbox.write', 'admin'];

type Fixture = Awaited<ReturnType<typeof fixture>>;
type AdminCall = [method: string, path: string, body?: unknown];

/** 每个 /v1/admin 接口一次调用：查询（mailbox.read）、写操作（mailbox.write）与 Claude 查询（mail.read） */
function adminCalls(f: Fixture, address = f.address('x')): { reads: AdminCall[]; writes: AdminCall[]; claude: AdminCall[] } {
  return {
    reads: [['GET', `/v1/admin/mailboxes?domain=${DOMAIN}`], ['GET', `/v1/admin/users?usernames=${f.owner.username}`], ['GET', '/v1/admin/hosted-domains']],
    writes: [
      ['POST', '/v1/admin/mailboxes/batch/claim', { userId: f.owner.id, items: [{ localPart: `${f.prefix}-x`, domain: DOMAIN }] }],
      ['POST', '/v1/admin/mailboxes/batch/release', { items: [{ address }] }],
      ['POST', '/v1/admin/mailboxes/batch/transfer', { userId: f.target.id, items: [{ address, expectedOwnerId: f.owner.id }] }],
      ['POST', '/v1/admin/mailboxes/batch/share', { userIds: [f.member.id], items: [{ address }] }],
      ['POST', '/v1/admin/mailboxes/batch/unshare', { userIds: [f.member.id], items: [{ address }] }],
      ['PUT', '/v1/admin/mailboxes/shares', { userIds: [], items: [{ address }] }],
    ],
    claude: [['GET', `/v1/admin/claude/domains?domains=${DOMAIN}`], ['GET', `/v1/admin/claude/addresses?addresses=${address}`]],
  };
}
const callInit = (method: string, body: unknown, key?: string): RequestInit & { key?: string } => ({ method, key,
  ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

describe('/v1/admin 鉴权', () => {
  it('无 Key 401（带 requestId）；普通用户 Key、不带 admin scope 的管理员 Key 都是 403；管理员 JWT 不能调用', async () => {
    const f = await fixture();
    const userKey = await f.keyFor(f.owner.jwt, { scopes: ['mailbox.read', 'mailbox.write', 'mailbox.share'] });
    const plainAdminKey = await f.keyFor(f.admin.jwt, { scopes: ['mailbox.read', 'mailbox.write', 'mailbox.share'] });
    const { reads, writes, claude } = adminCalls(f);
    for (const [method, path, body] of [...reads, ...writes, ...claude]) {
      const init = (key?: string) => callInit(method, body, key);
      const anonymous = await errorOf(await request(path, init()), 401);
      expect(anonymous.code, `${method} ${path}`).toBe('unauthorized');
      expect(anonymous.requestId, `${method} ${path}`).toMatch(/\S/);
      expect((await errorOf(await request(path, init(f.admin.jwt)), 401)).code, `${method} ${path}`).toBe('unauthorized');
      expect((await errorOf(await request(path, init(userKey.key)), 403)).code, `${method} ${path}`).toBe('forbidden');
      expect((await errorOf(await request(path, init(plainAdminKey.key)), 403)).code, `${method} ${path}`).toBe('forbidden');
    }
    // 什么都没写
    expect(await db.select().from(mailboxes).where(eq(mailboxes.address, f.address('x'))).all()).toEqual([]);
  });

  it('限定了邮箱或域名的管理员 Key 一律 403：管理员运维接口需要不限范围的管理员 Key', async () => {
    const f = await fixture();
    const own = await f.box(f.admin.id, 'own');
    const victim = await f.box(f.owner.id, 'victim');
    const byDomain = await f.keyFor(f.admin.jwt, { scopes: OPS_SCOPES, allowedDomains: [DOMAIN] });
    const byMailbox = await f.keyFor(f.admin.jwt, { scopes: OPS_SCOPES, allowedMailboxIds: [own.id] });
    const { reads, writes, claude } = adminCalls(f, victim.address);
    for (const key of [byDomain.key, byMailbox.key]) {
      for (const [method, path, body] of [...reads, ...writes, ...claude]) {
        const error = await errorOf(await request(path, callInit(method, body, key)), 403);
        expect(error.code, `${method} ${path}`).toBe('forbidden');
        expect((error as { fix?: string }).fix, `${method} ${path}`).toContain('不限范围的管理员 Key');
      }
    }
    // 范围内的邮箱也不放行，范围外的邮箱没有被释放或过户
    expect((await errorOf(await send('/v1/admin/mailboxes/batch/release', byMailbox.key, { items: [{ address: own.address }] }), 403)).code).toBe('forbidden');
    expect(await ownerOf(own.id)).toBe(f.admin.id);
    expect(await ownerOf(victim.id)).toBe(f.owner.id);
    // 同一账户不限范围的 Key 照常可用
    expect((await request(`/v1/admin/mailboxes?addresses=${victim.address}`, { key: f.adminKey.key })).status).toBe(200);
  });

  it('除 admin 外，写操作要求 mailbox.write，查询要求 mailbox.read，Claude 查询要求 mail.read', async () => {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'keep');
    const readOnly = await f.keyFor(f.admin.jwt, { scopes: ['mailbox.read', 'admin'] });
    const writeOnly = await f.keyFor(f.admin.jwt, { scopes: ['mailbox.write', 'admin'] });
    const { reads, writes, claude } = adminCalls(f, box.address);
    const denied = async (calls: AdminCall[], key: string, scope: string) => {
      for (const [method, path, body] of calls) {
        const error = await errorOf(await request(path, callInit(method, body, key)), 403);
        expect([error.code, error.message], `${method} ${path}`).toEqual(['forbidden', `需要 API scope: ${scope}`]);
      }
    };
    await denied(writes, readOnly.key, 'mailbox.write');
    await denied(reads, writeOnly.key, 'mailbox.read');
    await denied(claude, writeOnly.key, 'mail.read');
    await denied(claude, readOnly.key, 'mail.read');
    // 只读的管理员 Key 什么都没改
    expect(await ownerOf(box.id)).toBe(f.owner.id);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.address, f.address('x'))).all()).toEqual([]);
    for (const [method, path] of reads) expect((await request(path, { method, key: readOnly.key })).status, `${method} ${path}`).toBe(200);
    for (const [method, path] of claude) expect((await request(path, { method, key: f.adminKey.key })).status, `${method} ${path}`).toBe(200);
    const released = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/batch/release', writeOnly.key, { items: [{ address: box.address }] }));
    expect(released.done).toBe(1);
  });
});

describe('POST /v1/admin/mailboxes/batch/claim', () => {
  it('认领给 userId，再只把本次认领到的地址共享给 shareUserIds；审计操作人为管理员，detail 标注 API Key', async () => {
    const f = await fixture();
    const taken = await f.box(f.target.id, 'taken');
    const result = await data<AdminClaimAndShareResult>(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key, {
      userId: f.owner.id, shareUserIds: [f.member.id, f.member.id],
      items: [{ localPart: `${f.prefix}-new1`, domain: DOMAIN }, { localPart: `${f.prefix}-taken`, domain: DOMAIN }, { localPart: `${f.prefix}-new2`, domain: DOMAIN }],
    }, 'POST', `req-claim-${f.prefix}`));
    expect(result.claimed.map((box) => [box.address, box.userId])).toEqual([[f.address('new1'), f.owner.id], [f.address('new2'), f.owner.id]]);
    expect(result.taken).toEqual([{ localPart: `${f.prefix}-taken`, domain: DOMAIN }]);
    expect(result.stoppedBy).toBeNull();
    expect(result.shares).toMatchObject({ done: 2, unchanged: 0, failed: 0 });
    expect(result.shares!.results.map((item) => [item.address, item.status, item.addedShares])).toEqual([
      [f.address('new1'), 'done', 1], [f.address('new2'), 'done', 1]]);
    for (const box of result.claimed) expect(await membersOf(box.id)).toEqual([f.member.id]);
    // taken 的地址不属于本次认领，不共享
    expect(await membersOf(taken.id)).toEqual([]);

    const suffix = `；批量请求 req-claim-${f.prefix}（API Key #${f.adminKey.id}）`;
    const claims = await audits(f.admin.id, 'mailbox.claim');
    expect(claims.map((row) => [row.target, row.actorName, row.ip])).toEqual([
      [f.address('new1'), f.admin.username, IP], [f.address('new2'), f.admin.username, IP]]);
    for (const row of claims) expect(row.detail.endsWith(suffix), row.detail).toBe(true);
    const shares = await audits(f.admin.id, 'mailbox.share');
    expect(shares.map((row) => [row.target, row.actorName, row.detail])).toEqual([
      [f.address('new1'), f.admin.username, `追加共享 ${f.member.username}${suffix}`],
      [f.address('new2'), f.admin.username, `追加共享 ${f.member.username}${suffix}`]]);
  });

  it('不给 shareUserIds 或给空数组时 shares 为 null；没认领到地址时 shares 为空结果', async () => {
    const f = await fixture();
    const plain = await data<AdminClaimAndShareResult>(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: f.owner.id, items: [{ localPart: `${f.prefix}-a`, domain: DOMAIN }] }));
    expect(plain.claimed).toHaveLength(1);
    expect(plain.shares).toBeNull();
    const empty = await data<AdminClaimAndShareResult>(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: f.owner.id, shareUserIds: [], items: [{ localPart: `${f.prefix}-b`, domain: DOMAIN }] }));
    expect(empty.shares).toBeNull();
    const none = await data<AdminClaimAndShareResult>(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: f.owner.id, shareUserIds: [f.member.id], items: [{ localPart: `${f.prefix}-a`, domain: DOMAIN }] }));
    expect(none.claimed).toEqual([]);
    expect(none.taken).toHaveLength(1);
    expect(none.shares).toEqual({ results: [], done: 0, unchanged: 0, failed: 0 });
    // 保留前缀按目标用户的规则停止，之前认领的照常共享
    const stopped = await data<AdminClaimAndShareResult>(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: f.owner.id, shareUserIds: [f.member.id], items: [{ localPart: `${f.prefix}-c`, domain: DOMAIN }, { localPart: 'support', domain: DOMAIN }] }));
    expect(stopped.claimed.map((box) => box.address)).toEqual([f.address('c')]);
    expect(stopped.stoppedBy).not.toBeNull();
    expect(stopped.shares!.results.map((item) => item.address)).toEqual([f.address('c')]);
  });

  it('被分享人不存在、已禁用或是系统保留用户时整批 400，什么都不认领；目标用户不存在 404', async () => {
    const f = await fixture();
    const disabled = await f.actor('disabled');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, disabled.id));
    await db.insert(users).values({ username: 'ci-smoke', passwordHash: 'x', authVersionMigrated: true }).onConflictDoNothing();
    const reserved = (await db.select().from(users).where(eq(users.username, 'ci-smoke')).get())!;
    for (const shareUserIds of [[f.member.id, 999_999], [disabled.id], [reserved.id]]) {
      const error = await errorOf(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
        { userId: f.owner.id, shareUserIds, items: [{ localPart: `${f.prefix}-x`, domain: DOMAIN }] }), 400);
      expect(error.code).toBe('validation_failed');
    }
    expect(await db.select().from(mailboxes).where(eq(mailboxes.address, f.address('x'))).all()).toEqual([]);
    expect((await errorOf(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: 999_999, items: [{ localPart: `${f.prefix}-x`, domain: DOMAIN }] }), 404)).code).toBe('not_found');
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await errorOf(await send('/v1/admin/mailboxes/batch/claim', f.adminKey.key,
      { userId: f.owner.id, shareUserIds: tooMany, items: [{ localPart: `${f.prefix}-x`, domain: DOMAIN }] }), 400)).code).toBe('validation_failed');
  });

  it('认领提交后共享整体失败（被分享人在提交前被禁用）：认领保留，每个认领到的地址记为 failed 并带错误', async () => {
    const f = await fixture();
    const racing = beforeStatement(env, /'mailbox\.share'/, async () => {
      await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.member.id));
    });
    const result = await adminClaimAndShare(racing, { id: f.admin.id, ip: IP }, {
      userId: f.owner.id, shareUserIds: [f.member.id],
      items: [{ localPart: `${f.prefix}-a`, domain: DOMAIN }, { localPart: `${f.prefix}-b`, domain: DOMAIN }],
    }, 'tag');
    expect(result.claimed.map((box) => box.address)).toEqual([f.address('a'), f.address('b')]);
    expect(result.shares).toMatchObject({ done: 0, unchanged: 0, failed: 2 });
    expect(result.shares!.results.map((item) => [item.address, item.status, item.mailboxId, item.ownerId, item.error?.code])).toEqual(
      result.claimed.map((box) => [box.address, 'failed', box.id, f.owner.id, 'conflict']));
    for (const box of result.claimed) {
      expect(await ownerOf(box.id)).toBe(f.owner.id);
      expect(await membersOf(box.id)).toEqual([]);
    }
    expect(await audits(f.admin.id, 'mailbox.share')).toEqual([]);
  });
});

describe('POST /v1/admin/mailboxes/batch/{release,transfer,share,unshare}', () => {
  it('与 /api/admin 同一套服务：逐项结果、审计标注 API Key', async () => {
    const f = await fixture();
    const [a, b, c] = [await f.box(f.owner.id, 'a'), await f.box(f.owner.id, 'b'), await f.box(f.target.id, 'c')];
    const suffix = (id: string) => `；批量请求 ${id}（API Key #${f.adminKey.id}）`;

    const shared = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/batch/share', f.adminKey.key,
      { userIds: [f.member.id], items: [{ address: a.address }, { address: f.address('ghost') }] }, 'POST', `req-share-${f.prefix}`));
    expect(shared.results.map((item) => [item.status, item.error?.code ?? null])).toEqual([['done', null], ['failed', 'not_found']]);
    expect(await membersOf(a.id)).toEqual([f.member.id]);

    const unshared = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/batch/unshare', f.adminKey.key,
      { userIds: [f.member.id], items: [{ address: a.address }, { address: b.address }] }, 'POST', `req-unshare-${f.prefix}`));
    expect(unshared.results.map((item) => [item.status, item.revokedShares])).toEqual([['done', 1], ['unchanged', 0]]);

    const transferred = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/batch/transfer', f.adminKey.key,
      { userId: f.target.id, items: [{ address: a.address, expectedOwnerId: f.owner.id }, { address: c.address, expectedOwnerId: f.owner.id },
        { address: b.address, expectedOwnerId: f.member.id }] }, 'POST', `req-transfer-${f.prefix}`));
    expect(transferred.results.map((item) => [item.status, item.error?.code ?? null])).toEqual([['done', null], ['unchanged', null], ['failed', 'conflict']]);
    expect(await ownerOf(a.id)).toBe(f.target.id);
    expect(await ownerOf(b.id)).toBe(f.owner.id);

    await db.insert(messages).values({ address: b.address, domain: DOMAIN, direction: 'inbound', status: 'received', subject: 'history' });
    const released = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/batch/release', f.adminKey.key,
      { deleteHistory: true, items: [{ address: b.address, expectedOwnerId: f.owner.id }] }, 'POST', `req-release-${f.prefix}`));
    expect(released.results.map((item) => [item.status, item.deletedMessages])).toEqual([['done', 1]]);
    expect(await ownerOf(b.id)).toBeUndefined();

    for (const [action, id, target] of [['mailbox.share', 'share', a.address], ['mailbox.unshare', 'unshare', a.address],
      ['mailbox.transfer', 'transfer', a.address], ['mailbox.release', 'release', b.address]] as const) {
      const rows = await audits(f.admin.id, action);
      expect(rows.map((row) => [row.target, row.actorName]), action).toEqual([[target, f.admin.username]]);
      expect(rows[0]!.detail.endsWith(suffix(`req-${id}-${f.prefix}`)), rows[0]!.detail).toBe(true);
    }
  });

  it('参数非法整批 400：重复地址、缺 expectedOwnerId、超过上限', async () => {
    const f = await fixture();
    const bad = async (path: string, body: unknown) =>
      expect((await errorOf(await send(`/v1/admin/mailboxes/batch/${path}`, f.adminKey.key, body), 400)).code, path).toBe('validation_failed');
    await bad('release', { items: [{ address: f.address('d') }, { address: f.address('D').toUpperCase() }] });
    await bad('transfer', { userId: f.target.id, items: [{ address: f.address('t') }] });
    await bad('share', { userIds: [], items: [{ address: f.address('s') }] });
    await bad('unshare', { userIds: [f.member.id], items: Array.from({ length: 101 }, (_, i) => ({ address: f.address(`m${i}`) })) });
  });
});

describe('PUT /v1/admin/mailboxes/shares', () => {
  it('替换为目标名单：增减都有的为 done、已是目标的 unchanged、含所有者与不存在与所有者不符的失败；审计分增减两行', async () => {
    const f = await fixture();
    const [m1, m2, m3] = [f.member, await f.actor('m2'), await f.actor('m3')];
    const a = await f.box(f.owner.id, 'a');
    const b = await f.box(f.owner.id, 'b');
    const ownedByM3 = await f.box(m3.id, 'c');
    const wrongOwner = await f.box(f.owner.id, 'd');
    await f.share(a.id, m1.id, m2.id);
    await f.share(b.id, m2.id, m3.id);
    const requestId = `req-replace-${f.prefix}`;
    const result = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/shares', f.adminKey.key, {
      userIds: [m3.id, m2.id, m3.id],
      items: [{ address: a.address }, { address: b.address }, { address: ownedByM3.address }, { address: f.address('ghost') },
        { address: wrongOwner.address, expectedOwnerId: f.target.id }],
    }, 'PUT', requestId));
    expect(result).toMatchObject({ done: 1, unchanged: 1, failed: 3 });
    expect(result.results.map((item) => [item.address, item.status, item.error?.code ?? null, item.addedShares ?? null, item.revokedShares ?? null]))
      .toEqual([
        [a.address, 'done', null, 1, 1],
        [b.address, 'unchanged', null, 0, 0],
        [ownedByM3.address, 'failed', 'validation_failed', null, null],
        [f.address('ghost'), 'failed', 'not_found', null, null],
        [wrongOwner.address, 'failed', 'conflict', null, null],
      ]);
    expect(await membersOf(a.id)).toEqual(sorted(m2.id, m3.id));
    expect(await membersOf(b.id)).toEqual(sorted(m2.id, m3.id));
    expect(await membersOf(ownedByM3.id)).toEqual([]);

    const suffix = `；批量请求 ${requestId}（API Key #${f.adminKey.id}）`;
    expect((await audits(f.admin.id, 'mailbox.unshare')).map((row) => [row.target, row.actorName, row.detail]))
      .toEqual([[a.address, f.admin.username, `替换共享名单，移除 ${m1.username}${suffix}`]]);
    expect((await audits(f.admin.id, 'mailbox.share')).map((row) => [row.target, row.actorName, row.detail]))
      .toEqual([[a.address, f.admin.username, `替换共享名单，新增 ${m3.username}${suffix}`]]);
  });

  it('空数组清空名单；只增或只减时只记对应的一行审计；无成员的邮箱清空为 unchanged', async () => {
    const f = await fixture();
    const m2 = await f.actor('m2');
    const [a, b, c] = [await f.box(f.owner.id, 'a'), await f.box(f.owner.id, 'b'), await f.box(f.owner.id, 'c')];
    await f.share(a.id, f.member.id, m2.id);
    const cleared = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/shares', f.adminKey.key,
      { userIds: [], items: [{ address: a.address }, { address: b.address }] }, 'PUT'));
    expect(cleared.results.map((item) => [item.status, item.revokedShares, item.addedShares])).toEqual([['done', 2, 0], ['unchanged', 0, 0]]);
    expect(await membersOf(a.id)).toEqual([]);
    expect(await audits(f.admin.id, 'mailbox.share')).toEqual([]);
    expect((await audits(f.admin.id, 'mailbox.unshare')).map((row) => row.target)).toEqual([a.address]);

    const added = await data<AdminMailboxBatchResult>(await send('/v1/admin/mailboxes/shares', f.adminKey.key,
      { userIds: [f.member.id], items: [{ address: c.address, expectedOwnerId: f.owner.id }] }, 'PUT'));
    expect(added.results.map((item) => [item.status, item.addedShares, item.revokedShares])).toEqual([['done', 1, 0]]);
    expect(await membersOf(c.id)).toEqual([f.member.id]);
    expect((await audits(f.admin.id, 'mailbox.share')).map((row) => row.target)).toEqual([c.address]);
    expect(await audits(f.admin.id, 'mailbox.unshare')).toHaveLength(1);

    // 全部已是目标名单时只读一次，不开写入事务
    const batches: number[] = [];
    const counting = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => { batches.push(statements.length); return target.batch(statements); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const same = await adminReplaceShares(counting, { id: f.admin.id, ip: IP },
      { userIds: [f.member.id], items: [{ address: c.address }, { address: a.address, expectedOwnerId: f.owner.id }] }, 'tag');
    expect(same.results.map((item) => item.status)).toEqual(['unchanged', 'done']);
    expect(batches).toHaveLength(2);
    batches.length = 0;
    const unchanged = await adminReplaceShares(counting, { id: f.admin.id, ip: IP }, { userIds: [f.member.id], items: [{ address: c.address }, { address: a.address }] }, 'tag');
    expect(unchanged).toMatchObject({ done: 0, unchanged: 2, failed: 0 });
    expect(batches).toHaveLength(1);
  });

  it('目标用户不存在、已禁用或系统保留时整批 400，什么都不改；超过上限 400', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'a');
    await f.share(a.id, f.member.id);
    const disabled = await f.actor('disabled');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, disabled.id));
    await db.insert(users).values({ username: 'ci-smoke', passwordHash: 'x', authVersionMigrated: true }).onConflictDoNothing();
    const reserved = (await db.select().from(users).where(eq(users.username, 'ci-smoke')).get())!;
    for (const userIds of [[999_999], [disabled.id], [reserved.id], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      expect((await errorOf(await send('/v1/admin/mailboxes/shares', f.adminKey.key, { userIds, items: [{ address: a.address }] }, 'PUT'), 400)).code)
        .toBe('validation_failed');
    }
    expect(await membersOf(a.id)).toEqual([f.member.id]);
  });

  it('读取后邮箱被过户或被分享人被禁用时整批回滚并返回 409', async () => {
    const f = await fixture();
    const m2 = await f.actor('m2');
    const [a, b] = [await f.box(f.owner.id, 'a'), await f.box(f.owner.id, 'b')];
    await f.share(a.id, f.member.id);
    const actor = { id: f.admin.id, ip: IP };
    const req = { userIds: [m2.id], items: [{ address: a.address }, { address: b.address }] };
    const transferRace = beforeStatement(env, /DELETE FROM mailbox_shares/, async () => {
      await db.update(mailboxes).set({ userId: f.target.id }).where(eq(mailboxes.id, b.id));
    });
    await expect(adminReplaceShares(transferRace, actor, req, 'tag')).rejects.toMatchObject({ code: 'conflict' });
    await db.update(mailboxes).set({ userId: f.owner.id }).where(eq(mailboxes.id, b.id));
    const disableRace = beforeStatement(env, /DELETE FROM mailbox_shares/, async () => {
      await db.update(users).set({ status: 'disabled' }).where(eq(users.id, m2.id));
    });
    await expect(adminReplaceShares(disableRace, actor, req, 'tag')).rejects.toMatchObject({ code: 'conflict' });
    expect(await membersOf(a.id)).toEqual([f.member.id]);
    expect(await membersOf(b.id)).toEqual([]);
    expect(await audits(f.admin.id, 'mailbox.share')).toEqual([]);
    expect(await audits(f.admin.id, 'mailbox.unshare')).toEqual([]);
    // 没有并发修改时同一请求成功
    await db.update(users).set({ status: 'active' }).where(eq(users.id, m2.id));
    expect((await adminReplaceShares(env, actor, req, 'tag')).done).toBe(2);
  });
});

describe('GET /v1/admin/mailboxes', () => {
  it('按地址：只返回已认领的，带所有者与成员，按地址排序；逗号分隔与重复参数等价，大小写不敏感', async () => {
    const f = await fixture();
    const b = await f.box(f.owner.id, 'b');
    const a = await f.box(f.target.id, 'a');
    await f.share(b.id, f.member.id, f.target.id);
    const expected: AdminMailboxView[] = [
      { id: a.id, address: a.address, domain: DOMAIN, ownerId: f.target.id, ownerUsername: f.target.username, grantees: [], createdAt: a.createdAt.toISOString() },
      { id: b.id, address: b.address, domain: DOMAIN, ownerId: f.owner.id, ownerUsername: f.owner.username,
        grantees: [{ userId: f.member.id, username: f.member.username }, { userId: f.target.id, username: f.target.username }]
          .sort((x, y) => x.username.localeCompare(y.username)), createdAt: b.createdAt.toISOString() },
    ];
    const comma = `/v1/admin/mailboxes?addresses=${encodeURIComponent(`${b.address.toUpperCase()}, ${f.address('free')},${a.address}`)}`;
    expect(await data<AdminMailboxView[]>(await request(comma, { key: f.adminKey.key }))).toEqual(expected);
    const repeated = `/v1/admin/mailboxes?addresses=${encodeURIComponent(b.address)}&addresses=${encodeURIComponent(a.address)}`;
    expect(await data<AdminMailboxView[]>(await request(repeated, { key: f.adminKey.key }))).toEqual(expected);
  });

  it('按域名：返回该域全部已认领邮箱，不含其他域', async () => {
    const f = await fixture();
    const domain = `${f.prefix}.v1admin.test`;
    const [x, y] = [await f.box(f.owner.id, 'x', domain), await f.box(f.target.id, 'y', domain)];
    await f.box(f.owner.id, 'z', OTHER_DOMAIN);
    const list = await data<AdminMailboxView[]>(await request(`/v1/admin/mailboxes?domain=${domain.toUpperCase()}`, { key: f.adminKey.key }));
    expect(list.map((box) => [box.address, box.ownerId])).toEqual([[x.address, f.owner.id], [y.address, f.target.id]]);
    expect(await data<AdminMailboxView[]>(await request('/v1/admin/mailboxes?domain=nothing-here.test', { key: f.adminKey.key }))).toEqual([]);
  });

  it('列表先规整再去重：大小写不同的同一地址算一项，上限按去重后的项数计', async () => {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'dup');
    const same = [box.address.toUpperCase(), ` ${box.address} `, box.address].map(encodeURIComponent).join(',');
    expect((await data<AdminMailboxView[]>(await request(`/v1/admin/mailboxes?addresses=${same}`, { key: f.adminKey.key }))).map((item) => item.id))
      .toEqual([box.id]);
    const facts = await data<{ address: string }[]>(await request(`/v1/admin/claude/addresses?addresses=${same}`, { key: f.adminKey.key }));
    expect(facts.map((item) => item.address)).toEqual([box.address]);
    // 200 个地址各写一遍大小写变体：去重后正好 200 项，不超上限
    const distinct = Array.from({ length: 200 }, (_, i) => f.address(`n${i}`));
    const doubled = [...distinct, ...distinct.map((address) => address.toUpperCase())].join(',');
    expect(await data<AdminMailboxView[]>(await request(`/v1/admin/mailboxes?addresses=${doubled}`, { key: f.adminKey.key }))).toEqual([]);
  });

  it('addresses 与 domain 必须且只能给一个；地址非法或超过 200 个 400', async () => {
    const f = await fixture();
    const many = Array.from({ length: 201 }, (_, i) => f.address(`m${i}`)).join(',');
    for (const query of ['', `?domain=${DOMAIN}&addresses=${f.address('a')}`, '?addresses=not-an-address', `?addresses=${many}`, '?addresses=,,', '?domain=bad_domain']) {
      expect((await errorOf(await request(`/v1/admin/mailboxes${query}`, { key: f.adminKey.key }), 400)).code, query).toBe('validation_failed');
    }
  });
});

describe('GET /v1/admin/users', () => {
  it('按用户名查，不存在的不出现，按用户名排序，带角色、状态与专属额度', async () => {
    const f = await fixture();
    await db.update(users).set({ status: 'disabled', mailboxPolicy: { perUserLimit: 3, domains: [{ domain: DOMAIN, perUserLimit: 1 }] }, mailboxPolicyRevision: 2 })
      .where(eq(users.id, f.target.id));
    const list = await data<AdminUserView[]>(await request(
      `/v1/admin/users?usernames=${f.target.username.toUpperCase()},${f.prefix}-missing,${f.admin.username}&usernames=${f.owner.username}`, { key: f.adminKey.key }));
    expect(list).toEqual([
      { id: f.admin.id, username: f.admin.username, role: 'admin', status: 'active', mailboxPolicy: null, mailboxPolicyRevision: 0, createdAt: f.admin.createdAt.toISOString() },
      { id: f.owner.id, username: f.owner.username, role: 'user', status: 'active', mailboxPolicy: null, mailboxPolicyRevision: 0, createdAt: f.owner.createdAt.toISOString() },
      { id: f.target.id, username: f.target.username, role: 'user', status: 'disabled',
        mailboxPolicy: { perUserLimit: 3, domains: [{ domain: DOMAIN, perUserLimit: 1 }] }, mailboxPolicyRevision: 2, createdAt: f.target.createdAt.toISOString() },
    ]);
    for (const query of ['', '?usernames=', '?usernames=Bad Name!']) {
      expect((await errorOf(await request(`/v1/admin/users${query}`, { key: f.adminKey.key }), 400)).code, query).toBe('validation_failed');
    }
  });
});

describe('GET /v1/admin/hosted-domains', () => {
  it('按域名与所有者查（取交集），ready 要求五项都就绪；不带条件返回全站并按 id 升序', async () => {
    const f = await fixture();
    const name = (label: string) => `${f.prefix}-${label}.test`;
    const ready = { status: 'active' as const, zoneStatus: 'active', routingStatus: 'ready', sendingStatus: 'ready', catchAllReady: true };
    const rows = await db.insert(hostedDomains).values([
      { domain: name('ready'), userId: f.owner.id, ...ready },
      { domain: name('pending'), userId: f.owner.id, status: 'pending' },
      { domain: name('no-catchall'), userId: f.target.id, ...ready, catchAllReady: false },
      { domain: name('no-sending'), userId: f.target.id, ...ready, sendingStatus: 'pending' },
      { domain: name('zone'), userId: f.target.id, ...ready, zoneStatus: 'pending' },
      { domain: name('suspended'), userId: f.target.id, ...ready, status: 'suspended' },
    ]).returning();
    const lookup = async (query: string) => data<AdminHostedDomainView[]>(await request(`/v1/admin/hosted-domains${query}`, { key: f.adminKey.key }));

    const owned = await lookup(`?owner=${f.owner.username}`);
    expect(owned).toEqual([
      { id: rows[0]!.id, domain: name('ready'), ownerId: f.owner.id, ownerUsername: f.owner.username, status: 'active', zoneStatus: 'active',
        routingStatus: 'ready', sendingStatus: 'ready', catchAllReady: true, ready: true, createdAt: rows[0]!.createdAt.toISOString() },
      { id: rows[1]!.id, domain: name('pending'), ownerId: f.owner.id, ownerUsername: f.owner.username, status: 'pending', zoneStatus: '',
        routingStatus: '', sendingStatus: '', catchAllReady: false, ready: false, createdAt: rows[1]!.createdAt.toISOString() },
    ]);
    const byName = await lookup(`?domains=${rows.slice(2).map((row) => row.domain.toUpperCase()).reverse().join(',')},${name('unknown')}`);
    expect(byName.map((item) => [item.domain, item.ready])).toEqual(rows.slice(2).map((row) => [row.domain, false]));
    expect((await lookup(`?domains=${name('ready')},${name('no-sending')}&owner=${f.target.username}`)).map((item) => item.domain)).toEqual([name('no-sending')]);
    expect(await lookup(`?owner=${f.prefix}-nobody`)).toEqual([]);
    const all = await lookup('');
    const ids = all.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toEqual(expect.arrayContaining(rows.map((row) => row.id)));
    expect((await errorOf(await request('/v1/admin/hosted-domains?owner=Bad Name!', { key: f.adminKey.key }), 400)).code).toBe('validation_failed');
  });
});

describe('查询计划', () => {
  it('查询与替换共享不全表扫描（EXPLAIN）；无条件列出全站托管域名除外', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'plan-a');
    await f.share(a.id, f.member.id);
    await db.insert(hostedDomains).values({ domain: `${f.prefix}-plan.test`, userId: f.owner.id });
    const seen = new Map<string, unknown[]>();
    const recording = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        seen.set(query, []);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { seen.set(query, args); return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    await lookupAdminMailboxes(recording, { addresses: [a.address] });
    await lookupAdminMailboxes(recording, { domain: DOMAIN });
    await lookupAdminUsers(recording, { usernames: [f.owner.username] });
    await lookupAdminHostedDomains(recording, { domains: [`${f.prefix}-plan.test`] });
    await lookupAdminHostedDomains(recording, { owner: f.owner.username });
    await lookupAdminHostedDomains(recording, { domains: [`${f.prefix}-plan.test`], owner: f.owner.username });
    await adminReplaceShares(recording, { id: f.admin.id, ip: IP }, { userIds: [f.target.id], items: [{ address: a.address }] }, 'tag');
    expect(seen.size).toBeGreaterThan(5);
    for (const [sql, params] of seen) {
      const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const scans = plan.results.map((row) => row.detail).filter((detail) => detail.startsWith('SCAN') && !/VIRTUAL TABLE|CONSTANT ROW/.test(detail));
      expect(scans, sql).toEqual([]);
    }
    // 无条件只扫 hosted_domains 本身（全站列表，按设计）
    seen.clear();
    await lookupAdminHostedDomains(recording, {});
    const [sql] = [...seen.keys()];
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${sql!}`).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).filter((detail) => detail.startsWith('SCAN'))).toEqual(['SCAN h']);
  });
});
