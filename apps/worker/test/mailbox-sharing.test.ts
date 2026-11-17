import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Mailbox, MailboxShareGrant, MessageDetail, MessageSummary, Page, SharedMailboxView } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { getMailbox } from '../src/services/mailbox.js';
import { listMailboxShares, replaceMailboxShares, shareMailboxes } from '../src/services/mailbox-share.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
let sequence = 0;

async function fixture() {
  const prefix = `sharing-${++sequence}`;
  await updateSettings(env, { security: { require2fa: false }, api: { enabled: true } });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role,
      passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  const owner = await actor('owner');
  const admin = await actor('admin', 'admin');
  const member = await actor('member');
  const stranger = await actor('stranger');
  const box = (await db.insert(mailboxes).values({ address: `${prefix}@sharing.test`,
    domain: 'sharing.test', userId: owner.id }).returning().get())!;
  const incoming = (await db.insert(messages).values({ address: box.address, domain: box.domain,
    fromAddress: 'sender@example.com', direction: 'inbound', subject: 'shared history', bodyText: 'private body',
    status: 'received', verificationCode: '123456' }).returning().get())!;
  const sent = (await db.insert(messages).values({ address: box.address, domain: box.domain,
    fromAddress: box.address, direction: 'outbound', subject: 'private sent', status: 'sent' }).returning().get())!;
  return { owner, admin, member, stranger, box, incoming, sent };
}

async function request(path: string, jwt: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response): Promise<T> {
  const result = await response.json() as { data: T };
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result.data;
}
/** 第 at 次 batch 执行前（after 时为执行后）运行一次 hook */
function hookBatch(hook: () => Promise<void>, at: number, after: boolean): Env {
  let calls = 0;
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const current = ++calls;
      if (current === at && !after) await hook();
      const result = await target.batch(statements);
      if (current === at && after) await hook();
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}
/** 第 at 次 batch 执行前运行一次 hook（默认第一次） */
const beforeBatch = (hook: () => Promise<void>, at = 1) => hookBatch(hook, at, false);
const afterBatch = (hook: () => Promise<void>, at = 1) => hookBatch(hook, at, true);

describe('所有者共享与管理员全站共享', () => {
  it('普通用户共享自己的邮箱给用户和管理员；成员只有来信读取权，撤销立即生效', async () => {
    const f = await fixture();
    const grant = await data<MailboxShareGrant>(await request('/mailboxes/shares', f.owner.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.owner.id, userIds: [f.member.id, f.admin.id],
    }));
    expect(grant).toMatchObject({ ownerUserId: f.owner.id, ownerUsername: f.owner.username });
    expect(grant.grantees).toHaveLength(2);
    const owned = await data<MailboxShareGrant[]>(await request('/mailboxes/shares', f.owner.jwt));
    expect(owned.map((item) => item.mailboxId)).toContain(f.box.id);
    for (const member of [f.member, f.admin]) {
      const shared = await data<SharedMailboxView[]>(await request('/mailboxes/shared', member.jwt));
      expect(shared.map((item) => item.mailboxId)).toContain(f.box.id);
      const inbox = await data<Page<MessageSummary>>(await request('/messages?direction=inbound', member.jwt));
      expect(inbox.items.map((item) => item.id)).toContain(f.incoming.id);
      expect(await data<MessageDetail>(await request(`/messages/${f.incoming.id}`, member.jwt))).toMatchObject({ bodyText: 'private body' });
      expect((await request(`/messages/${f.sent.id}`, member.jwt)).status).toBe(404);
      expect(await data(await request('/messages/read', member.jwt, 'POST', { ids: [f.incoming.id], isRead: true }))).toMatchObject({ changed: 0 });
    }
    expect(await data(await request('/messages/delete', f.member.jwt, 'POST', { ids: [f.incoming.id] }))).toMatchObject({ deleted: 0 });
    expect((await request(`/mailboxes/${f.box.id}`, f.member.jwt, 'PUT', { displayName: 'unauthorized' })).status).toBe(404);
    expect((await request('/mailboxes/shares', f.member.jwt, 'PUT', { mailboxId: f.box.id, userIds: [f.stranger.id] })).status).toBe(403);
    expect((await request('/admin/mailbox-shares', f.owner.jwt)).status).toBe(403);
    expect((await request(`/messages/${f.incoming.id}`, f.stranger.jwt)).status).toBe(404);
    await data(await request(`/mailboxes/shares/${f.box.id}/grantees/${f.member.id}`, f.owner.jwt, 'DELETE'));
    expect((await request(`/messages/${f.incoming.id}`, f.member.jwt)).status).toBe(404);
    await data(await request('/mailboxes/shares', f.owner.jwt, 'PUT', { mailboxId: f.box.id, userIds: [] }));
    expect((await request(`/messages/${f.incoming.id}`, f.admin.jwt)).status).toBe(404);
  });

  it('管理员可共享他人邮箱给自己和其他人，全站列表返回所有者并记录审计', async () => {
    const f = await fixture();
    const all = await data<MailboxShareGrant[]>(await request('/admin/mailbox-shares', f.admin.jwt));
    expect(all.find((item) => item.mailboxId === f.box.id)).toMatchObject({ ownerUsername: f.owner.username });
    await data(await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.owner.id, userIds: [f.admin.id, f.member.id],
    }));
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, f.box.id)).get())!.userId).toBe(f.owner.id);
    expect(await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, f.box.address))).toHaveLength(1);
    await data(await request(`/admin/mailbox-shares/${f.box.id}/grantees/${f.member.id}`, f.admin.jwt, 'DELETE'));
    expect((await request(`/messages/${f.incoming.id}`, f.member.jwt)).status).toBe(404);
    expect((await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, userIds: [f.owner.id],
    })).status).toBe(400);
    expect((await request('/admin/mailbox-shares', f.admin.jwt, 'PUT', {
      mailboxId: f.box.id, expectedOwnerId: f.member.id, userIds: [],
    })).status).toBe(409);
  });

  it('共享候选搜索仅返回必要公开字段，支持管理员并排除所有者', async () => {
    const f = await fixture();
    const result = await data<{ items: Array<Record<string, unknown>> }>(await request(
      `/mailboxes/share-users?q=sharing-${sequence}&excludeUserId=${f.owner.id}`, f.owner.jwt));
    expect(result.items.some((item) => item.id === f.admin.id)).toBe(true);
    expect(result.items.some((item) => item.id === f.owner.id)).toBe(false);
    for (const item of result.items) expect(Object.keys(item).sort()).toEqual(['id', 'username']);
    expect((await request('/mailboxes/share-users?q=', f.owner.jwt)).status).toBe(400);
  });

  it('写入边界用户被禁用时回滚整份共享名单，不丢失已有授权', async () => {
    const f = await fixture();
    await replaceMailboxShares(env, f.owner.id, f.box.id, [f.member.id]);
    const racing = beforeBatch(async () => {
      await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.stranger.id));
    });
    await expect(replaceMailboxShares(racing, f.admin.id, f.box.id, [f.stranger.id], true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, f.box.id))).map((row) => row.userId)).toEqual([f.member.id]);
  });

  it('管理员共享也复核写入时归属，不能覆盖并发过户后的新共享', async () => {
    const f = await fixture();
    const racing = beforeBatch(async () => {
      await db.update(mailboxes).set({ userId: f.stranger.id }).where(eq(mailboxes.id, f.box.id));
      await replaceMailboxShares(env, f.stranger.id, f.box.id, [f.member.id]);
    });
    await expect(replaceMailboxShares(racing, f.admin.id, f.box.id, [], true)).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, f.box.id))).map((row) => row.userId)).toEqual([f.member.id]);
  });
});

/** 统计 D1 往返：每次 batch 与每条单独执行的语句各算一次 */
function counting(): { env: Env; trips: () => number } {
  let trips = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        if (['first', 'all', 'run', 'raw'].includes(String(property))) trips++;
        return method.apply(target, args);
      };
    },
  });
  return { env: { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
    if (property === 'batch') return (statements: D1PreparedStatement[]) => { trips++; return target.batch(statements); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) }, trips: () => trips };
}

describe('管理员按 id 读邮箱与按邮箱读共享', () => {
  it('GET /admin/mailboxes/:id 与全站列表同形（含所有者与邮件数），不存在返回 404，非管理员 403', async () => {
    const f = await fixture();
    const box = await data<Mailbox>(await request(`/admin/mailboxes/${f.box.id}`, f.admin.jwt));
    const all = await data<Mailbox[]>(await request('/mailboxes?all=1', f.admin.jwt));
    expect(box).toEqual(all.find((entry) => entry.id === f.box.id));
    expect(box).toMatchObject({ address: f.box.address, ownerUsername: f.owner.username, messageCount: 2 });
    for (const id of ['999999999', 'abc']) {
      const missing = await request(`/admin/mailboxes/${id}`, f.admin.jwt);
      expect(missing.status).toBe(404);
      expect((await missing.json() as { error: { code: string } }).error.code).toBe('not_found');
    }
    expect((await request(`/admin/mailboxes/${f.box.id}`, f.owner.jwt)).status).toBe(403);
    const probe = counting();
    await getMailbox(probe.env, f.box.id);
    expect(probe.trips()).toBe(1);
  });

  it('?mailboxId= 只返回该邮箱，与全站列表中的同一项一致；不存在为空，非法参数 400', async () => {
    const f = await fixture();
    await replaceMailboxShares(env, f.owner.id, f.box.id, [f.stranger.id, f.member.id]);
    const all = await data<MailboxShareGrant[]>(await request('/admin/mailbox-shares', f.admin.jwt));
    const one = await data<MailboxShareGrant[]>(await request(`/admin/mailbox-shares?mailboxId=${f.box.id}`, f.admin.jwt));
    expect(one).toEqual([all.find((item) => item.mailboxId === f.box.id)]);
    expect(one[0]!.grantees.map((grantee) => grantee.username)).toEqual([f.member.username, f.stranger.username].sort());
    expect(await data(await request('/admin/mailbox-shares?mailboxId=999999999', f.admin.jwt))).toEqual([]);
    for (const bad of ['0', '-1', 'abc', '1.5', '', '1e3', '99999999999999999999']) {
      expect((await request(`/admin/mailbox-shares?mailboxId=${bad}`, f.admin.jwt)).status).toBe(400);
    }
    expect((await request(`/admin/mailbox-shares?mailboxId=${f.box.id}`, f.owner.jwt)).status).toBe(403);
  });

  it('共享列表一次查询：邮箱按地址排序，未共享的也列出，被分享人按用户名排序', async () => {
    const f = await fixture();
    const earlier = (await db.insert(mailboxes).values({ address: f.box.address.replace('@', '-a@'),
      domain: f.box.domain, userId: f.owner.id }).returning().get())!;
    // 最后创建（id 最大）但用户名排最前，区分按用户名与按 id 排序
    const first = (await db.insert(users).values({ username: f.owner.username.replace(/owner$/, 'aaa'), passwordHash: 'test' }).returning().get())!;
    await replaceMailboxShares(env, f.owner.id, f.box.id, [f.stranger.id, first.id, f.member.id, f.admin.id]);
    const expectedGrantees = [first, f.admin, f.member, f.stranger].map((user) => user.username).sort();
    expect(expectedGrantees[0]).toBe(first.username);
    let probe = counting();
    const owned = await listMailboxShares(probe.env, f.owner.id);
    expect(probe.trips()).toBe(1);
    expect(owned.map((grant) => grant.address)).toEqual([earlier.address, f.box.address]);
    expect(owned[0]).toMatchObject({ mailboxId: earlier.id, ownerUserId: f.owner.id, ownerUsername: f.owner.username, grantees: [] });
    expect(owned[1]!.grantees.map((grantee) => grantee.username)).toEqual(expectedGrantees);
    expect(owned[1]!.grantees.every((grantee) => grantee.status === 'active' && !Number.isNaN(Date.parse(grantee.grantedAt)))).toBe(true);
    probe = counting();
    const all = await listMailboxShares(probe.env, f.admin.id, true);
    expect(probe.trips()).toBe(1);
    const addresses = all.map((grant) => grant.address);
    expect(addresses).toEqual([...addresses].sort());
    expect(all.filter((grant) => grant.ownerUserId === f.owner.id)).toEqual(owned);
  });
});

describe('所有者批量共享多只邮箱', () => {
  /** 为 owner 新建邮箱；地址按 suffix 排序，便于区分请求顺序与地址顺序 */
  async function ownedBoxes(f: Awaited<ReturnType<typeof fixture>>, ownerId: number, ...suffixes: string[]) {
    return Promise.all(suffixes.map(async (suffix) => (await db.insert(mailboxes).values({
      address: f.box.address.replace('@', `-${suffix}@`), domain: f.box.domain, userId: ownerId }).returning().get())!));
  }
  async function shareRows(...mailboxIds: number[]) {
    return (await db.select().from(mailboxShares)).filter((row) => mailboxIds.includes(row.mailboxId));
  }
  async function errorOf(response: Response) {
    return { status: response.status, ...(await response.json() as { error: { code: string; message: string } }).error };
  }

  it('管理员把自己的多只邮箱一次共享给普通用户：返回顺序同去重后的请求，成员随即可见，两次 D1 往返', async () => {
    const f = await fixture();
    const [c, a, b] = await ownedBoxes(f, f.admin.id, 'c', 'a', 'b');
    const grants = await data<MailboxShareGrant[]>(await request('/mailboxes/shares/batch', f.admin.jwt, 'POST', {
      mailboxIds: [c!.id, a!.id, b!.id, a!.id], userIds: [f.member.id, f.member.id],
    }));
    expect(grants.map((grant) => grant.mailboxId)).toEqual([c!.id, a!.id, b!.id]);
    for (const grant of grants) {
      expect(grant).toMatchObject({ ownerUserId: f.admin.id, ownerUsername: f.admin.username });
      expect(grant.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id]);
    }
    const shared = await data<SharedMailboxView[]>(await request('/mailboxes/shared', f.member.jwt));
    expect(shared.map((item) => item.mailboxId)).toEqual(expect.arrayContaining([a!.id, b!.id, c!.id]));
    expect(await shareRows(a!.id, b!.id, c!.id)).toHaveLength(3);
    expect(await shareRows(a!.id).then((rows) => rows[0]!.grantedBy)).toBe(f.admin.id);
    const probe = counting();
    await shareMailboxes(probe.env, f.admin.id, [a!.id, b!.id, c!.id], [f.stranger.id]);
    expect(probe.trips()).toBe(2);
  });

  it('追加不替换：已有成员保留原授权时间与授权人，重复调用幂等', async () => {
    const f = await fixture();
    const [second] = await ownedBoxes(f, f.owner.id, 'second');
    await replaceMailboxShares(env, f.admin.id, f.box.id, [f.member.id], true);
    const grantedAt = new Date('2020-01-02T03:04:05.000Z');
    await db.update(mailboxShares).set({ createdAt: grantedAt }).where(eq(mailboxShares.mailboxId, f.box.id));
    const body = { mailboxIds: [f.box.id, second!.id], userIds: [f.stranger.id] };
    const first = await data<MailboxShareGrant[]>(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', body));
    expect(first[0]!.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id, f.stranger.id]);
    expect(first[0]!.grantees[0]!.grantedAt).toBe(grantedAt.toISOString());
    expect(first[1]!.grantees.map((grantee) => grantee.userId)).toEqual([f.stranger.id]);
    expect(await data(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', body))).toEqual(first);
    const again = await data<MailboxShareGrant[]>(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', {
      mailboxIds: [second!.id, f.box.id], userIds: [f.member.id, f.stranger.id],
    }));
    expect(again[1]).toEqual(first[0]);
    expect(again[0]!.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id, f.stranger.id]);
    const kept = (await shareRows(f.box.id)).find((row) => row.userId === f.member.id)!;
    expect(kept).toMatchObject({ grantedBy: f.admin.id, createdAt: grantedAt });
    expect(await shareRows(f.box.id, second!.id)).toHaveLength(4);
  });

  it('任一邮箱不属于调用者（含管理员共享他人邮箱、不存在的邮箱）返回 403，整单不写入', async () => {
    const f = await fixture();
    const [adminBox] = await ownedBoxes(f, f.admin.id, 'admin');
    const cases: Array<[string, number[]]> = [
      [f.owner.jwt, [f.box.id, adminBox!.id]],
      [f.admin.jwt, [adminBox!.id, f.box.id]],
      [f.admin.jwt, [adminBox!.id, 999999999]],
      [f.member.jwt, [f.box.id]],
    ];
    for (const [jwt, mailboxIds] of cases) {
      expect(await errorOf(await request('/mailboxes/shares/batch', jwt, 'POST', { mailboxIds, userIds: [f.stranger.id] })))
        .toEqual({ status: 403, code: 'forbidden', message: '只能共享自己已认领的地址' });
    }
    expect(await shareRows(f.box.id, adminBox!.id)).toEqual([]);
  });

  it('用户含自己、不存在或已禁用，或参数非法时返回 400，整单不写入', async () => {
    const f = await fixture();
    const [second] = await ownedBoxes(f, f.owner.id, 'second');
    const disabled = (await db.insert(users).values({ username: `${f.owner.username}-disabled`, passwordHash: 'test',
      status: 'disabled' }).returning().get())!;
    const mailboxIds = [f.box.id, second!.id];
    for (const [userIds, message] of [
      [[f.member.id, f.owner.id], '邮箱所有者已经拥有访问权限，无需共享'],
      [[f.member.id, 999999999], '包含不存在的用户'],
      [[f.member.id, disabled.id], '只能共享给启用中的用户'],
    ] as const) {
      expect(await errorOf(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', { mailboxIds, userIds })))
        .toEqual({ status: 400, code: 'validation_failed', message });
    }
    for (const body of [{ mailboxIds: [], userIds: [f.member.id] }, { mailboxIds, userIds: [] }, { mailboxIds: [f.box.id] },
      { mailboxIds: Array.from({ length: 101 }, (_, i) => i + 1), userIds: [f.member.id] }]) {
      expect((await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', body)).status).toBe(400);
    }
    expect(await shareRows(...mailboxIds)).toEqual([]);
    // 含自己在任何 D1 往返之前就拒绝
    const probe = counting();
    await expect(shareMailboxes(probe.env, f.owner.id, mailboxIds, [f.member.id, f.owner.id]))
      .rejects.toMatchObject({ code: 'validation_failed', message: '邮箱所有者已经拥有访问权限，无需共享' });
    expect(probe.trips()).toBe(0);
  });

  /** 被分享人用户行已不存在的共享（残留数据） */
  async function orphanShare(f: Awaited<ReturnType<typeof fixture>>) {
    await env.db.prepare('INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by) VALUES (?, ?, ?)')
      .bind(f.box.id, 999999999, f.owner.id).run();
  }

  it('被分享人用户行缺失的共享不出现在 GET 名单中', async () => {
    const f = await fixture();
    await replaceMailboxShares(env, f.owner.id, f.box.id, [f.member.id]);
    await orphanShare(f);
    const owned = await data<MailboxShareGrant[]>(await request('/mailboxes/shares', f.owner.jwt));
    const admin = await data<MailboxShareGrant[]>(await request(`/admin/mailbox-shares?mailboxId=${f.box.id}`, f.admin.jwt));
    expect(owned.find((grant) => grant.mailboxId === f.box.id)!.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id]);
    expect(admin).toEqual(owned.filter((grant) => grant.mailboxId === f.box.id));
  });

  it('被分享人用户行缺失的共享不出现在批量共享的返回中', async () => {
    const f = await fixture();
    await orphanShare(f);
    const grants = await data<MailboxShareGrant[]>(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', {
      mailboxIds: [f.box.id], userIds: [f.member.id],
    }));
    expect(grants[0]!.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id]);
  });

  it('追加后任一邮箱超过 100 人返回 400，已在名单的用户不重复计数', async () => {
    const f = await fixture();
    const [second] = await ownedBoxes(f, f.owner.id, 'second');
    const crowd = (await env.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 99)
      INSERT INTO users (username, password_hash) SELECT ? || n, 'test' FROM seq WHERE 1 RETURNING id`)
      .bind(`${f.owner.username}-crowd-`).all<{ id: number }>()).results.map((row) => row.id);
    await env.db.prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
      SELECT ?, value, ? FROM json_each(?)`).bind(f.box.id, f.owner.id, JSON.stringify(crowd)).run();
    const full = await data<MailboxShareGrant[]>(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', {
      mailboxIds: [second!.id, f.box.id], userIds: [crowd[0], f.member.id],
    }));
    expect(full.map((grant) => grant.grantees.length)).toEqual([2, 100]);
    expect(await errorOf(await request('/mailboxes/shares/batch', f.owner.jwt, 'POST', {
      mailboxIds: [second!.id, f.box.id], userIds: [f.stranger.id],
    }))).toEqual({ status: 400, code: 'validation_failed', message: '每只邮箱最多共享给 100 个用户' });
    expect((await shareRows(second!.id)).map((row) => row.userId).sort()).toEqual([crowd[0], f.member.id].sort());
    expect(await shareRows(f.box.id)).toHaveLength(100);
  });

  it('校验后到写入前被过户、释放、禁用、删除用户或名单被并发填满时返回 409，所有邮箱都不留部分共享', async () => {
    const races: Array<[string, (f: Awaited<ReturnType<typeof fixture>>, boxes: { id: number }[]) => Promise<void>]> = [
      ['过户', async (f, [, last]) => { await db.update(mailboxes).set({ userId: f.stranger.id }).where(eq(mailboxes.id, last!.id)); }],
      ['释放', async (_, [, last]) => { await db.delete(mailboxes).where(eq(mailboxes.id, last!.id)); }],
      ['禁用', async (f) => { await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.member.id)); }],
      ['删除用户', async (f) => { await db.delete(users).where(eq(users.id, f.member.id)); }],
      ['名单已满', async (f, [, last]) => {
        await env.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100)
          INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by) SELECT ?, 1000000 + n, ? FROM seq`)
          .bind(last!.id, f.admin.id).run();
      }],
    ];
    for (const [name, race] of races) {
      const f = await fixture();
      const boxes = await ownedBoxes(f, f.admin.id, 'first', 'last');
      const ids = boxes.map((box) => box.id);
      const before = await shareRows(...ids);
      // 第二次 batch 才是写入（第一次是校验读取）
      const racing = beforeBatch(() => race(f, boxes), 2);
      await expect(shareMailboxes(racing, f.admin.id, ids, [f.member.id, f.stranger.id]), name)
        .rejects.toMatchObject({ code: 'conflict' });
      const after = await shareRows(...ids);
      expect(after.filter((row) => row.userId === f.member.id || row.userId === f.stranger.id), name).toEqual([]);
      expect(after.length - before.length, name).toBe(name === '名单已满' ? 100 : 0);
    }
  });

  it('校验后到写入前的并发替换或追加不报 409，按主键合并', async () => {
    const f = await fixture();
    const [a, b] = await ownedBoxes(f, f.admin.id, 'a', 'b');
    const racing = beforeBatch(async () => {
      await replaceMailboxShares(env, f.admin.id, a!.id, [f.member.id, f.stranger.id]);
    }, 2);
    const grants = await shareMailboxes(racing, f.admin.id, [a!.id, b!.id], [f.member.id]);
    expect(grants.map((grant) => grant.grantees.map((grantee) => grantee.userId)))
      .toEqual([[f.member.id, f.stranger.id], [f.member.id]]);
  });

  it('返回值在写入的同一事务里读回：提交后再过户或释放不会让已生效的请求报冲突', async () => {
    const f = await fixture();
    const [a, b, c] = await ownedBoxes(f, f.admin.id, 'a', 'b', 'c');
    // 第二次 batch 是写入；它提交后立刻过户 b、释放 c
    const racing = afterBatch(async () => {
      await db.update(mailboxes).set({ userId: f.stranger.id }).where(eq(mailboxes.id, b!.id));
      await db.delete(mailboxes).where(eq(mailboxes.id, c!.id));
    }, 2);
    const grants = await shareMailboxes(racing, f.admin.id, [c!.id, a!.id, b!.id], [f.member.id]);
    expect(grants.map((grant) => grant.mailboxId)).toEqual([c!.id, a!.id, b!.id]);
    for (const grant of grants) {
      expect(grant).toMatchObject({ ownerUserId: f.admin.id, ownerUsername: f.admin.username });
      expect(grant.grantees.map((grantee) => grantee.userId)).toEqual([f.member.id]);
    }
  });

  it('未登录返回 401', async () => {
    const ctx = createExecutionContext();
    const response = await app.request('/api/mailboxes/shares/batch', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mailboxIds: [1], userIds: [2] }) }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});
