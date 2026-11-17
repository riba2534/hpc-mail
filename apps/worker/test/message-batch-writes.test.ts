import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { externalAttachmentLinks, mailboxShares, mailboxes, messages, stars, storageCleanupJobs, users } from '../src/db/schema.js';
import { D1_MAX_BOUND_PARAMS } from '../src/lib/d1.js';
import {
  deleteMessages, markMessages, purgeMessages, restoreMessages, starMessages, type Viewer,
} from '../src/services/message.js';
import { EXPIRED_LINKS_SQL, expireExternalAttachmentLinks } from '../src/services/storage-cleanup.js';

/**
 * 记录经过 env.db 的往返：batch 调用（及其中语句的 SQL）与 batch 之外直接执行的语句；
 * 同时检查每条语句的绑定参数个数（测试环境不执行 D1 单语句 100 个的上限，这里替它把关）。
 */
function recording() {
  const batches: string[][] = [];
  const standalone: string[] = [];
  const params: number[] = [];
  const sqlOf = new WeakMap<object, string>();
  const wrap = (stmt: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(stmt, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => { params.push(args.length); return wrap(target.bind(...args), query); };
        if (key === 'all' || key === 'run' || key === 'first' || key === 'raw') {
          return (...args: unknown[]) => { standalone.push(query); return (target[key] as (...a: unknown[]) => unknown)(...args); };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    sqlOf.set(proxy, query);
    raw.set(proxy, stmt);
    return proxy;
  };
  const raw = new WeakMap<object, D1PreparedStatement>();
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => wrap(target.prepare(query), query);
      if (property === 'batch') return (statements: D1PreparedStatement[]) => {
        batches.push(statements.map((s) => sqlOf.get(s) ?? ''));
        return target.batch(statements.map((s) => raw.get(s) ?? s));
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, db } as typeof env, batches, standalone, params };
}

async function setup(prefix: string) {
  const db = createDb(env);
  const [user, owner, stranger] = await db.insert(users).values([
    { username: `${prefix}-user`, passwordHash: 'x', role: 'user', authVersionMigrated: true },
    { username: `${prefix}-owner`, passwordHash: 'x', role: 'user', authVersionMigrated: true },
    { username: `${prefix}-stranger`, passwordHash: 'x', role: 'user', authVersionMigrated: true },
  ]).returning({ id: users.id });
  const [, sharedBox] = await db.insert(mailboxes).values([
    { address: `${prefix}@bw.test`, domain: 'bw.test', userId: user!.id },
    { address: `${prefix}-shared@bw.test`, domain: 'bw.test', userId: owner!.id },
    { address: `${prefix}-other@bw.test`, domain: 'bw.test', userId: stranger!.id },
  ]).returning({ id: mailboxes.id });
  await db.insert(mailboxShares).values({ mailboxId: sharedBox!.id, userId: user!.id, grantedBy: owner!.id });
  const inserted = await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
    INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
    SELECT 'inbound', ?, 'bw.test', 'f@example.net', 's', 'p', 'received' FROM n RETURNING id`).bind(`${prefix}@bw.test`).all<{ id: number }>();
  const [shared, foreign] = await db.insert(messages).values([
    { direction: 'inbound', address: `${prefix}-shared@bw.test`, domain: 'bw.test', subject: 's', status: 'received' },
    { direction: 'inbound', address: `${prefix}-other@bw.test`, domain: 'bw.test', subject: 's', status: 'received' },
  ]).returning({ id: messages.id });
  const own = inserted.results.map((row) => row.id);
  return { viewer: { userId: user!.id, role: 'user' } as Viewer, own, shared: shared!.id, foreign: foreign!.id, ids: [...own, shared!.id, foreign!.id] };
}

/** 测试自己的核对查询也受 D1 单语句 100 个绑定参数的限制：id 列表用一个 JSON 参数传 */
const idIn = (ids: number[]) => sql`${messages.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

describe('批量写：各批合进一次 batch', () => {
  it('已读/星标/取消星标/删除/恢复：202 个 id 切成 3 批、一次往返，每条语句绑定参数不超过 100；可见范围与改动数不变', async () => {
    const { viewer, own, shared, foreign, ids } = await setup('bw-ops');
    const db = createDb(env);
    const expectOneBatch = (rec: ReturnType<typeof recording>, label: string) => {
      expect(rec.batches, label).toHaveLength(1);
      expect(rec.batches[0], label).toHaveLength(3);
      expect(rec.standalone, label).toEqual([]);
      expect(Math.max(...rec.params), label).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    };

    // 已读是邮件本身的状态：共享来的与别人的都不动
    let rec = recording();
    expect(await markMessages(rec.env, viewer, ids, true)).toBe(200);
    expectOneBatch(rec, 'mark');
    const unread = await db.select({ id: messages.id }).from(messages).where(and(inArray(messages.id, [shared, foreign]), eq(messages.isRead, false)));
    expect(unread).toHaveLength(2);

    // 星标是个人标记：自己的 200 封加共享来的 1 封可见，别人的不可见；重复星标不重复计数
    rec = recording();
    expect(await starMessages(rec.env, viewer, ids, true)).toBe(201);
    expectOneBatch(rec, 'star');
    expect(await starMessages(env, viewer, ids, true)).toBe(0);
    const starred = await db.select({ id: stars.messageId }).from(stars).where(eq(stars.userId, viewer.userId));
    expect(starred.map((row) => row.id).sort((a, b) => a - b)).toEqual([...own, shared].sort((a, b) => a - b));
    // 别人星标的同一封邮件不受影响
    await db.insert(stars).values({ userId: viewer.userId + 1, messageId: own[0]! });
    rec = recording();
    expect(await starMessages(rec.env, viewer, ids, false)).toBe(201);
    expectOneBatch(rec, 'unstar');
    expect(await db.select().from(stars).where(eq(stars.messageId, own[0]!))).toHaveLength(1);

    // 删除与恢复只作用于自己认领的地址
    rec = recording();
    expect(await deleteMessages(rec.env, viewer, ids)).toBe(200);
    expectOneBatch(rec, 'delete');
    expect(await deleteMessages(env, viewer, ids)).toBe(0);
    rec = recording();
    expect(await restoreMessages(rec.env, viewer, ids)).toBe(200);
    expectOneBatch(rec, 'restore');
    expect(await db.select({ id: messages.id }).from(messages).where(and(idIn(ids), isNotNull(messages.deletedAt)))).toHaveLength(0);
  });

  it('永久删除：各批预订共用一个 purge token，与删除语句同一次 batch；只删回收站里自己的邮件', async () => {
    const { viewer, own, shared, foreign, ids } = await setup('bw-purge');
    await deleteMessages(env, viewer, own.slice(0, 150));
    const rec = recording();
    const ctx = createExecutionContext();
    expect(await purgeMessages(rec.env, viewer, ids, ctx)).toBe(150);
    await waitOnExecutionContext(ctx);
    const purgeBatches = rec.batches.filter((statements) => statements.some((sql) => /purge_token/.test(sql)));
    expect(purgeBatches).toHaveLength(1);
    expect(purgeBatches[0]!.filter((sql) => /^update "messages" set "purge_token"/.test(sql))).toHaveLength(3);
    expect(rec.standalone.filter((sql) => /purge_token/.test(sql))).toEqual([]);
    expect(Math.max(...rec.params)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    const left = await createDb(env).select({ id: messages.id }).from(messages).where(idIn(ids));
    expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual([...own.slice(150), shared, foreign].sort((a, b) => a - b));
  });
});

describe('外链过期：台账写入与删除同一批行', () => {
  it('一次 batch 把过期外链的对象写进清理台账并删掉外链行，未过期的不动；沿 idx_external_links_expiry 取', async () => {
    const db = createDb(env);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86_400_000);
    const link = (attachmentId: number, expiresAt: Date) =>
      ({ attachmentId, r2Key: `att/links/${attachmentId}`, filename: 'f', mimeType: 'text/plain', size: 1, expiresAt });
    await db.insert(externalAttachmentLinks).values([link(910_001, past), link(910_002, past), link(910_003, past), link(910_004, future)]);
    const rec = recording();
    expect(await expireExternalAttachmentLinks(rec.env)).toBe(3);
    expect(rec.batches).toHaveLength(1);
    expect(rec.standalone).toEqual([]);
    const remaining = await db.select({ id: externalAttachmentLinks.attachmentId }).from(externalAttachmentLinks)
      .where(inArray(externalAttachmentLinks.attachmentId, [910_001, 910_002, 910_003, 910_004]));
    expect(remaining.map((row) => row.id)).toEqual([910_004]);
    const jobs = await db.select({ key: storageCleanupJobs.r2Key }).from(storageCleanupJobs)
      .where(inArray(storageCleanupJobs.r2Key, ['att/links/910001', 'att/links/910002', 'att/links/910003', 'att/links/910004']));
    expect(jobs.map((row) => row.key).sort()).toEqual(['att/links/910001', 'att/links/910002', 'att/links/910003']);
    expect(await expireExternalAttachmentLinks(env)).toBe(0);

    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${EXPIRED_LINKS_SQL}`).bind(Date.now()).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(' | ')).toMatch(/SEARCH external_attachment_links USING (?:COVERING )?INDEX idx_external_links_expiry \(expires_at<\?\)/);
  });
});
