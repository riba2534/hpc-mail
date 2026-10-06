import type { MailboxShareGrant, SharedMailboxView } from '@hpc-mail/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { mailboxShares, mailboxes, users } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';

const MAX_GRANTEES = 100;

function assertOwnMailbox<T extends { userId: number }>(
  box: T | undefined,
  adminId: number,
): asserts box is T {
  if (!box || box.userId !== adminId) {
    throw new AppError('forbidden', '只能共享自己已认领的地址');
  }
}

/** 当前管理员名下全部已认领邮箱，附带共享名单（含尚未分享的） */
export async function listMailboxShares(env: Env, adminId: number): Promise<MailboxShareGrant[]> {
  const db = createDb(env);
  const boxes = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.userId, adminId))
    .orderBy(asc(mailboxes.address))
    .all();
  if (boxes.length === 0) return [];

  const rows = [];
  for (const batch of chunk(boxes.map((box) => box.id))) {
    const part = await db
      .select({
        mailboxId: mailboxShares.mailboxId,
        userId: mailboxShares.userId,
        username: users.username,
        grantedAt: mailboxShares.createdAt,
      })
      .from(mailboxShares)
      .innerJoin(users, eq(users.id, mailboxShares.userId))
      .where(inArray(mailboxShares.mailboxId, batch))
      .orderBy(asc(users.username))
      .all();
    rows.push(...part);
  }

  const byMailbox = new Map<number, MailboxShareGrant['grantees']>();
  for (const row of rows) {
    const list = byMailbox.get(row.mailboxId) ?? [];
    list.push({
      userId: row.userId,
      username: row.username,
      grantedAt: row.grantedAt.toISOString(),
    });
    byMailbox.set(row.mailboxId, list);
  }

  return boxes.map((box) => ({
    mailboxId: box.id,
    address: box.address,
    domain: box.domain,
    displayName: box.displayName,
    grantees: byMailbox.get(box.id) ?? [],
  }));
}

/**
 * 整体替换一只邮箱的共享名单。
 * 调用者必须是该邮箱的认领管理员；被分享人必须是启用中的普通用户。
 */
export async function replaceMailboxShares(
  env: Env,
  adminId: number,
  mailboxId: number,
  userIds: number[],
): Promise<MailboxShareGrant> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertOwnMailbox(box, adminId);

  const uniqueIds = [...new Set(userIds)];
  if (uniqueIds.length > MAX_GRANTEES) {
    throw new AppError('validation_failed', `一次最多共享给 ${MAX_GRANTEES} 个用户`);
  }
  if (uniqueIds.includes(adminId)) {
    throw new AppError('validation_failed', '不能把邮箱共享给自己');
  }
  if (uniqueIds.length > 0) {
    const targets = [];
    for (const batch of chunk(uniqueIds)) {
      const part = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(inArray(users.id, batch))
        .all();
      targets.push(...part);
    }
    if (targets.length !== uniqueIds.length) {
      throw new AppError('validation_failed', '包含不存在的用户');
    }
    if (targets.some((target) => target.role !== 'user' || target.status !== 'active')) {
      throw new AppError('validation_failed', '只能共享给启用中的普通用户');
    }
  }

  await env.db.batch([
    env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id = ?
      AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`).bind(mailboxId, mailboxId, adminId),
    ...uniqueIds.map((userId) =>
      env.db
        .prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
          SELECT id, ?, ? FROM mailboxes WHERE id = ? AND user_id = ?`)
        .bind(userId, adminId, mailboxId, adminId),
    ),
  ]);
  assertOwnMailbox(await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get(), adminId);

  return {
    mailboxId: box.id,
    address: box.address,
    domain: box.domain,
    displayName: box.displayName,
    grantees: await granteesOf(env, mailboxId),
  };
}

export async function revokeMailboxShare(
  env: Env,
  adminId: number,
  mailboxId: number,
  userId: number,
): Promise<void> {
  const db = createDb(env);
  const box = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get();
  assertOwnMailbox(box, adminId);
  const result = await db
    .delete(mailboxShares)
    .where(and(eq(mailboxShares.mailboxId, mailboxId), eq(mailboxShares.userId, userId),
      sql`EXISTS (SELECT 1 FROM mailboxes WHERE id = ${mailboxId} AND user_id = ${adminId})`))
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new AppError('not_found', '该用户不在共享名单中');
}

/** 登录用户被分享、且主人仍是启用中管理员的邮箱 */
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
    .where(and(eq(mailboxShares.userId, userId), eq(users.role, 'admin'), eq(users.status, 'active')))
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
    grantedAt: row.grantedAt.toISOString(),
  }));
}
