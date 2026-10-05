import type { ClaimMailboxRequest, Mailbox, MailboxAvailability, Role } from '@hpc-mail/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { mailboxes, messages, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { domainPerUserLimit, getDomains, isDomainPublic } from './domain.js';
import { getSettingsFresh } from './setting.js';
import { purgeStatements } from './message-lifecycle.js';
import { processStorageCleanup } from './storage-cleanup.js';
import { getActiveAdminIds } from './user.js';

type MailboxRow = typeof mailboxes.$inferSelect;

const messageCountSql = sql<number>`(SELECT COUNT(*) FROM messages WHERE messages.address = mailboxes.address)`;

function serialize(row: MailboxRow, messageCount: number, ownerUsername?: string): Mailbox {
  return {
    id: row.id,
    address: row.address,
    domain: row.domain,
    userId: row.userId,
    displayName: row.displayName,
    messageCount,
    createdAt: row.createdAt.toISOString(),
    ...(ownerUsername !== undefined ? { ownerUsername } : {}),
  };
}

export async function listMailboxes(
  env: Env,
  opts: { userId?: number; all?: boolean },
): Promise<Mailbox[]> {
  const db = createDb(env);
  if (opts.all) {
    const rows = await db
      .select({ mailbox: mailboxes, username: users.username, messageCount: messageCountSql })
      .from(mailboxes)
      .leftJoin(users, eq(users.id, mailboxes.userId))
      .orderBy(desc(mailboxes.id))
      .all();
    return rows.map((r) => serialize(r.mailbox, Number(r.messageCount), r.username ?? ''));
  }
  const rows = await db
    .select({ mailbox: mailboxes, messageCount: messageCountSql })
    .from(mailboxes)
    .where(eq(mailboxes.userId, opts.userId!))
    .orderBy(desc(mailboxes.id))
    .all();
  return rows.map((r) => serialize(r.mailbox, Number(r.messageCount)));
}

/** 认领地址：domain 必须 ∈ 系统域名，address 全局唯一，普通用户受保留前缀/配额限制 */
export async function claimMailbox(
  env: Env,
  userId: number,
  role: Role,
  req: ClaimMailboxRequest,
): Promise<Mailbox> {
  const settings = await getSettingsFresh(env);
  const domains = await getDomains(env, settings);
  if (!domains.includes(req.domain)) {
    throw new AppError('validation_failed', '域名不在系统域名列表内');
  }
  const db = createDb(env);
  let perUserLimit = 0;
  let perDomainLimit = 0;

  // 普通用户：域名可见性 + 保留前缀 + 全局上限 + 按域名上限（管理员全部豁免）
  if (role !== 'admin') {
    // 可见性：只能认领对普通用户公开的域名（未公开的域名对普通用户等同不存在）
    if (!isDomainPublic(settings, req.domain)) {
      throw new AppError('forbidden', '该域名未对普通用户开放');
    }
    const policy = settings.mailbox_policy;
    perUserLimit = policy.perUserLimit;
    // 保留前缀禁止认领（防冒充官方身份）
    if (policy.reservedLocalParts.includes(req.localPart)) {
      throw new AppError('forbidden', `前缀 ${req.localPart} 为系统保留，无法认领`);
    }
    // 全局每用户认领上限（跨域名合计，防囤积）
    if (policy.perUserLimit > 0) {
      const owned = await db
        .select({ value: sql<number>`COUNT(*)` })
        .from(mailboxes)
        .where(eq(mailboxes.userId, userId))
        .get();
      if ((owned?.value ?? 0) >= policy.perUserLimit) {
        throw new AppError('forbidden', `认领地址数已达上限（${policy.perUserLimit}）`);
      }
    }
    // 按域名上限：统计该用户在此域名下已认领数
    const domainLimit = domainPerUserLimit(settings, req.domain);
    perDomainLimit = domainLimit;
    if (domainLimit > 0) {
      const ownedInDomain = await db
        .select({ value: sql<number>`COUNT(*)` })
        .from(mailboxes)
        .where(and(eq(mailboxes.userId, userId), eq(mailboxes.domain, req.domain)))
        .get();
      if ((ownedInDomain?.value ?? 0) >= domainLimit) {
        throw new AppError('forbidden', `在该域名下最多认领 ${domainLimit} 个地址`);
      }
    }
  }

  const address = `${req.localPart}@${req.domain}`;
  const existing = await db.select().from(mailboxes).where(eq(mailboxes.address, address)).get();
  if (existing) throw new AppError('address_taken', '该地址已被占用');
  try {
    // Domain revision and quotas are checked in the same write as INSERT. A
    // concurrent domain removal/private toggle must not create a stale claim.
    const inserted = await env.db
      .prepare(
        `INSERT INTO mailboxes (address, domain, user_id, display_name)
         SELECT ?, ?, ?, ''
         WHERE (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?) < ?)
           AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
           AND COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ?
           AND EXISTS (SELECT 1 FROM settings, json_each(settings.value, '$.list') AS configured
             WHERE settings.key = 'domains'
               AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
                 ELSE json_extract(configured.value, '$.domain') END)) = ?)
         RETURNING id`,
      )
      .bind(
        address,
        req.domain,
        userId,
        perUserLimit,
        userId,
        perUserLimit,
        perDomainLimit,
        userId,
        req.domain,
        perDomainLimit,
        settings.domains.revision ?? 0,
        req.domain,
      )
      .first<{ id: number }>();
    if (!inserted) {
      const current = await getSettingsFresh(env);
      if ((current.domains.revision ?? 0) !== (settings.domains.revision ?? 0)) {
        throw new AppError('conflict', '域名配置已改变，请刷新后重试');
      }
      throw new AppError('forbidden', '认领配额已在并发请求中用尽，请刷新后重试');
    }
    const row = await db.select().from(mailboxes).where(eq(mailboxes.id, inserted.id)).get();
    if (!row) throw new AppError('internal', '地址认领失败');
    const count = await db.select({ value: sql<number>`COUNT(*)` }).from(messages).where(eq(messages.address, address)).get();
    return serialize(row, Number(count?.value ?? 0));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: mailboxes.address')) {
      throw new AppError('address_taken', '该地址已被占用');
    }
    throw error;
  }
}

export async function updateMailbox(
  env: Env,
  userId: number,
  id: number,
  displayName: string,
  isAdmin: boolean,
): Promise<Mailbox> {
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  await db.update(mailboxes).set({ displayName }).where(eq(mailboxes.id, id));
  const [updated] = await db
    .select({ mailbox: mailboxes, messageCount: messageCountSql })
    .from(mailboxes)
    .where(eq(mailboxes.id, id))
    .all();
  return serialize(updated!.mailbox, Number(updated!.messageCount));
}

/**
 * 释放地址。默认历史邮件不动（随地址回到未认领态，下一个认领者可见）；
 * deleteHistory=true 时同时删除该地址名下全部邮件——堵住「释放后被他人继承验证码/账单」的隐私路径。
 */
export async function releaseMailbox(
  env: Env,
  userId: number,
  id: number,
  isAdmin: boolean,
  deleteHistory = false,
): Promise<{ deletedMessages: number }> {
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  const token = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [];
  if (deleteHistory) {
    statements.push(env.db.prepare(`UPDATE messages SET purge_token = ? WHERE address = ?
      AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`)
      .bind(token, row.address, row.id, row.userId));
    statements.push(...purgeStatements(env, token));
  }
  statements.push(env.db.prepare('DELETE FROM mailbox_shares WHERE mailbox_id = ?').bind(row.id));
  statements.push(env.db.prepare('DELETE FROM mailboxes WHERE id = ? AND user_id = ?').bind(row.id, row.userId));
  // One D1 transaction includes every message present at release, including concurrent inbound.
  const result = await env.db.batch(statements);
  const deletedMessages = deleteHistory ? (result[4]?.meta.changes ?? 0) : 0;
  if (deleteHistory) await processStorageCleanup(env, 100);
  return { deletedMessages };
}

export async function checkAvailability(
  env: Env,
  localPart: string,
  domain: string,
): Promise<MailboxAvailability> {
  const address = `${localPart}@${domain}`;
  const domains = await getDomains(env, await getSettingsFresh(env));
  if (!domains.includes(domain)) return { address, available: false };
  const db = createDb(env);
  const existing = await db.select().from(mailboxes).where(eq(mailboxes.address, address)).get();
  return { address, available: !existing };
}

/** 取用户认领的全部地址（用于 messages 可见性过滤） */
export async function userAddresses(env: Env, userId: number): Promise<string[]> {
  const db = createDb(env);
  const rows = await db
    .select({ address: mailboxes.address })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId))
    .all();
  return rows.map((r) => r.address);
}

/** 地址 → 认领它的用户 id（地址全局唯一，至多一个 owner）；未认领返回 null */
export async function getMailboxOwner(env: Env, address: string): Promise<number | null> {
  const db = createDb(env);
  const row = await db
    .select({ userId: mailboxes.userId })
    .from(mailboxes)
    .where(eq(mailboxes.address, address))
    .get();
  return row?.userId ?? null;
}

/** 通知归属：已认领 → 主人；未认领 → 全部启用中的管理员。收信当时结算。 */
export async function resolveNotifyOwnerIds(env: Env, address: string): Promise<number[]> {
  const ownerId = await getMailboxOwner(env, address);
  if (ownerId !== null) return [ownerId];
  return getActiveAdminIds(env);
}

/** 校验地址归属（发件身份校验用） */
export async function userOwnsAddress(env: Env, userId: number, address: string): Promise<boolean> {
  const db = createDb(env);
  const row = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, userId), eq(mailboxes.address, address)))
    .get();
  return row !== undefined;
}
