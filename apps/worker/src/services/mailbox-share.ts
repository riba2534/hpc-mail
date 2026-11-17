import { MAX_MAILBOX_GRANTEES, RESERVED_USERNAMES, type MailboxShareGrant, type SharedMailboxView } from '@hpc-mail/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createDb } from '../db/client.js';
import { mailboxShares, mailboxes, users } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';

function assertManageableMailbox<T extends { userId: number }>(
  box: T | undefined,
  actorId: number,
  isAdmin = false,
): asserts box is T {
  if (!box || (!isAdmin && box.userId !== actorId)) {
    throw new AppError('forbidden', '只能共享自己已认领的地址');
  }
}

const owners = alias(users, 'owners');

/** 被分享人复核：存在、不是系统保留账号（共享给 CI 冒烟用户会干扰部署流水线）、已启用 */
function assertShareTargets(targets: readonly { username: string; status: string }[], expected: number): void {
  if (targets.length !== expected) {
    throw new AppError('validation_failed', '包含不存在的用户');
  }
  if (targets.some((target) => RESERVED_USERNAMES.includes(target.username))) {
    throw new AppError('validation_failed', '系统保留用户不能作为共享成员');
  }
  if (targets.some((target) => target.status !== 'active')) {
    throw new AppError('validation_failed', '只能共享给启用中的用户');
  }
}

/** 邮箱 LEFT JOIN 共享与被分享人后的扁平行；没有共享时 grantee 字段为 null */
interface ShareGrantRow {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUserId: number;
  ownerUsername: string;
  granteeId: number | null;
  granteeUsername: string | null;
  granteeStatus: 'active' | 'disabled' | null;
  grantedAt: Date | number | null;
}

/** 按邮箱分组（保持行的先后顺序），被分享人用户行缺失的共享不展示 */
function toShareGrants(rows: readonly ShareGrantRow[]): MailboxShareGrant[] {
  const grants = new Map<number, MailboxShareGrant>();
  for (const row of rows) {
    let grant = grants.get(row.mailboxId);
    if (!grant) {
      grant = {
        mailboxId: row.mailboxId,
        address: row.address,
        domain: row.domain,
        displayName: row.displayName,
        ownerUserId: row.ownerUserId,
        ownerUsername: row.ownerUsername,
        grantees: [],
      };
      grants.set(row.mailboxId, grant);
    }
    if (row.granteeId === null || row.granteeUsername === null || row.granteeStatus === null || row.grantedAt === null) continue;
    grant.grantees.push({
      userId: row.granteeId,
      username: row.granteeUsername,
      status: row.granteeStatus,
      grantedAt: new Date(row.grantedAt).toISOString(),
    });
  }
  return [...grants.values()];
}

/**
 * 自有或全站已认领邮箱，附带所有者与共享名单（含尚未分享的）。
 * 一条 JOIN 查询：邮箱按地址、共享按被分享人用户名排序；mailboxId 只取该邮箱（0 或 1 项）。
 */
export async function listMailboxShares(env: Env, actorId: number, all = false, mailboxId?: number): Promise<MailboxShareGrant[]> {
  const db = createDb(env);
  const rows = await db
    .select({
      mailboxId: mailboxes.id,
      address: mailboxes.address,
      domain: mailboxes.domain,
      displayName: mailboxes.displayName,
      ownerUserId: mailboxes.userId,
      ownerUsername: owners.username,
      granteeId: mailboxShares.userId,
      granteeUsername: users.username,
      granteeStatus: users.status,
      grantedAt: mailboxShares.createdAt,
    })
    .from(mailboxes)
    .innerJoin(owners, eq(owners.id, mailboxes.userId))
    .leftJoin(mailboxShares, eq(mailboxShares.mailboxId, mailboxes.id))
    .leftJoin(users, eq(users.id, mailboxShares.userId))
    .where(and(all ? undefined : eq(mailboxes.userId, actorId), mailboxId === undefined ? undefined : eq(mailboxes.id, mailboxId)))
    .orderBy(asc(mailboxes.address), asc(users.username))
    .all();
  return toShareGrants(rows);
}

/**
 * 整体替换一只邮箱的共享名单。
 * 所有者可管理自己的邮箱，管理员可管理任意邮箱；被分享人必须启用。
 */
export async function replaceMailboxShares(
  env: Env,
  actorId: number,
  mailboxId: number,
  userIds: number[],
  isAdmin = false,
  expectedOwnerId?: number,
): Promise<MailboxShareGrant> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(box, actorId, isAdmin);
  if (expectedOwnerId !== undefined && box.userId !== expectedOwnerId) {
    throw new AppError('conflict', '邮箱所有者已改变，请刷新后重试');
  }

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length > MAX_MAILBOX_GRANTEES) {
    throw new AppError('validation_failed', `一次最多共享给 ${MAX_MAILBOX_GRANTEES} 个用户`);
  }
  if (uniqueIds.includes(box.userId)) {
    throw new AppError('validation_failed', '邮箱所有者已经拥有访问权限，无需共享');
  }
  if (uniqueIds.length > 0) {
    const targets = [];
    for (const batch of chunk(uniqueIds)) {
      const part = await db
        .select({ id: users.id, username: users.username, status: users.status })
        .from(users)
        .where(inArray(users.id, batch))
        .all();
      targets.push(...part);
    }
    assertShareTargets(targets, uniqueIds.length);
  }

  try {
    await env.db.batch([
      env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id = ?
        AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`).bind(mailboxId, mailboxId, box.userId),
      ...uniqueIds.map((userId) =>
        env.db
          .prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
          SELECT id, CASE WHEN (SELECT status FROM users WHERE id = ?) = 'active' THEN ? ELSE NULL END, ?
          FROM mailboxes WHERE id = ? AND user_id = ?`)
          .bind(userId, userId, actorId, mailboxId, box.userId),
      ),
    ]);
  } catch (error) {
    if (String(error).includes('NOT NULL constraint failed: mailbox_shares.user_id')) {
      throw new AppError('conflict', '共享用户状态已改变，请刷新后重试');
    }
    throw error;
  }
  const current = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(current, actorId, isAdmin);
  if (current.userId !== box.userId) throw new AppError('conflict', '邮箱所有者已改变，请刷新后重试');
  const owner = await db.select({ username: users.username }).from(users).where(eq(users.id, box.userId)).get();

  return {
    mailboxId: box.id,
    address: box.address,
    domain: box.domain,
    displayName: box.displayName,
    ownerUserId: box.userId,
    ownerUsername: owner!.username,
    grantees: await granteesOf(env, mailboxId),
  };
}

/**
 * 所有者把自己的多只邮箱一次共享给同一批用户：追加到各自名单，已有成员保留原授权时间，不移除任何人。
 * 两次往返：校验读取一个 batch；写入与读回同一个 batch（同一事务），写入内复核归属、被分享人状态与人数上限，
 * 任一失败整单回滚，提交后不再失败。返回各邮箱更新后的完整名单，顺序同去重后的 mailboxIds。
 */
export async function shareMailboxes(
  env: Env,
  ownerId: number,
  mailboxIds: readonly number[],
  userIds: readonly number[],
): Promise<MailboxShareGrant[]> {
  const boxIds = [...new Set(mailboxIds)];
  const granteeIds = [...new Set(userIds)];
  // 写入靠逐对复核归属，至少要有一对
  if (boxIds.length === 0 || granteeIds.length === 0) {
    throw new AppError('validation_failed', '至少选择一只邮箱和一个用户');
  }
  if (granteeIds.includes(ownerId)) {
    throw new AppError('validation_failed', '邮箱所有者已经拥有访问权限，无需共享');
  }
  // id 数组以 JSON 参数传入：语句数与绑定参数不随邮箱数 × 用户数膨胀
  const boxJson = JSON.stringify(boxIds);
  const granteeJson = JSON.stringify(granteeIds);
  const [ownedResult, targetResult, sizeResult] = await env.db.batch([
    env.db.prepare('SELECT id FROM mailboxes WHERE id IN (SELECT value FROM json_each(?)) AND user_id = ?').bind(boxJson, ownerId),
    env.db.prepare('SELECT id, username, status FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(granteeJson),
    // 追加后的人数 = 现有成员 + 本次用户 − 本次用户中已在名单里的
    env.db.prepare(`SELECT mailbox_id, COUNT(*) + ? - SUM(user_id IN (SELECT value FROM json_each(?))) AS total
      FROM mailbox_shares WHERE mailbox_id IN (SELECT value FROM json_each(?)) GROUP BY mailbox_id`)
      .bind(granteeIds.length, granteeJson, boxJson),
  ]);
  if ((ownedResult?.results ?? []).length !== boxIds.length) {
    throw new AppError('forbidden', '只能共享自己已认领的地址');
  }
  assertShareTargets((targetResult?.results ?? []) as { username: string; status: string }[], granteeIds.length);
  if (granteeIds.length > MAX_MAILBOX_GRANTEES
    || ((sizeResult?.results ?? []) as { total: number }[]).some((row) => row.total > MAX_MAILBOX_GRANTEES)) {
    throw new AppError('validation_failed', `每只邮箱最多共享给 ${MAX_MAILBOX_GRANTEES} 个用户`);
  }

  let rows: ShareGrantRow[];
  try {
    const results = await env.db.batch([
      // 归属或被分享人状态已变时写入 NULL，触发 NOT NULL 使整批回滚；
      // 不用 OR IGNORE（会吞掉 NOT NULL 失败），已有共享只按主键冲突跳过。INSERT ... SELECT 需带 WHERE 才能接 ON CONFLICT
      env.db.prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
        SELECT boxes.value,
          CASE WHEN EXISTS (SELECT 1 FROM mailboxes WHERE id = boxes.value AND user_id = ?)
            AND EXISTS (SELECT 1 FROM users WHERE id = grantees.value AND status = 'active')
          THEN grantees.value ELSE NULL END, ?
        FROM json_each(?) AS boxes, json_each(?) AS grantees WHERE 1
        ON CONFLICT (mailbox_id, user_id) DO NOTHING`).bind(ownerId, ownerId, boxJson, granteeJson),
      // 并发追加使名单超出上限时同样回滚（user_id 用不存在的 0，只触发 granted_by 的 NOT NULL）
      env.db.prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
        SELECT mailbox_id, 0, NULL FROM mailbox_shares
        WHERE mailbox_id IN (SELECT value FROM json_each(?)) GROUP BY mailbox_id HAVING COUNT(*) > ?`).bind(boxJson, MAX_MAILBOX_GRANTEES),
      // 同一事务读回：上面的写入已逐只确认归属，这里看到的就是本次提交后的名单。
      // 列按 ShareGrantRow 起别名，也避免 JOIN 同名列互相覆盖
      env.db.prepare(`SELECT m.id AS mailboxId, m.address, m.domain, m.display_name AS displayName,
          m.user_id AS ownerUserId, o.username AS ownerUsername, s.user_id AS granteeId,
          u.username AS granteeUsername, u.status AS granteeStatus, s.created_at AS grantedAt
        FROM mailboxes m
        JOIN users o ON o.id = m.user_id
        LEFT JOIN mailbox_shares s ON s.mailbox_id = m.id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE m.id IN (SELECT value FROM json_each(?))
        ORDER BY u.username`).bind(boxJson),
    ]);
    rows = (results[2]?.results ?? []) as ShareGrantRow[];
  } catch (error) {
    if (String(error).includes('NOT NULL constraint failed: mailbox_shares.user_id')) {
      throw new AppError('conflict', '邮箱所有者或共享用户状态已改变，请刷新后重试');
    }
    if (String(error).includes('NOT NULL constraint failed: mailbox_shares.granted_by')) {
      throw new AppError('conflict', '共享名单已改变，请刷新后重试');
    }
    throw error;
  }

  const grants = new Map(toShareGrants(rows).map((grant) => [grant.mailboxId, grant]));
  return boxIds.flatMap((id) => grants.get(id) ?? []);
}

export async function revokeMailboxShare(
  env: Env,
  actorId: number,
  mailboxId: number,
  userId: number,
  isAdmin = false,
): Promise<void> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertManageableMailbox(box, actorId, isAdmin);
  const result = await db
    .delete(mailboxShares)
    .where(and(eq(mailboxShares.mailboxId, mailboxId), eq(mailboxShares.userId, userId),
      sql`EXISTS (SELECT 1 FROM mailboxes WHERE id = ${mailboxId} AND user_id = ${box.userId})`))
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new AppError('not_found', '该用户不在共享名单中');
}

/** 登录用户被分享、且所有者仍启用的邮箱。 */
export async function listSharedMailboxes(env: Env, userId: number): Promise<SharedMailboxView[]> {
  const db = createDb(env);
  const rows = await db
    .select({
      mailboxId: mailboxes.id,
      address: mailboxes.address,
      domain: mailboxes.domain,
      displayName: mailboxes.displayName,
      ownerUsername: users.username,
    })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(eq(mailboxShares.userId, userId), eq(users.status, 'active')))
    .orderBy(asc(mailboxes.address))
    .all();
  return rows;
}

async function granteesOf(env: Env, mailboxId: number): Promise<MailboxShareGrant['grantees']> {
  const db = createDb(env);
  const rows = await db
    .select({
      userId: mailboxShares.userId,
      username: users.username,
      status: users.status,
      grantedAt: mailboxShares.createdAt,
    })
    .from(mailboxShares)
    .innerJoin(users, eq(users.id, mailboxShares.userId))
    .where(eq(mailboxShares.mailboxId, mailboxId))
    .orderBy(asc(users.username))
    .all();
  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
  }));
}
