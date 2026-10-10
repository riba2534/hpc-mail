import type {
  ClaimMailboxRequest, Mailbox, MailboxAvailability, MailboxTransferResult, MailboxUnavailableReason, Role, Settings,
  TransferMailboxRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { mailboxes, messages, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Env } from '../types.js';
import { domainPerUserLimit, isDomainPublic } from './domain.js';
import { getSettingsFresh } from './setting.js';
import { PURGE_MESSAGES_INDEX, purgeStatements } from './message-lifecycle.js';
import { processStorageCleanup } from './storage-cleanup.js';

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

interface ClaimPolicy {
  /** 普通用户的全局/按域认领上限（0=不限；管理员恒为 0），供 INSERT 时原子复核 */
  perUserLimit: number;
  perDomainLimit: number;
  /** 第一条不满足的规则；null 表示规则层面可认领（地址占用另判） */
  blocked: { reason: MailboxUnavailableReason; error: AppError } | null;
}

/**
 * 认领规则唯一来源：认领与可用性检查共用，避免两处判定漂移。
 * 顺序：域名可用 → 保留前缀 → 全局上限 → 按域名上限（管理员只受域名存在性约束）。
 */
async function evaluateClaimPolicy(
  db: Db,
  settings: Settings,
  actor: { userId: number; role: Role },
  localPart: string,
  domain: string,
): Promise<ClaimPolicy> {
  const allow = (perUserLimit = 0, perDomainLimit = 0): ClaimPolicy => ({ perUserLimit, perDomainLimit, blocked: null });
  const block = (reason: MailboxUnavailableReason, error: AppError): ClaimPolicy => ({ perUserLimit: 0, perDomainLimit: 0, blocked: { reason, error } });
  if (!settings.domains.list.some((entry) => entry.domain === domain)) {
    return block('domain_unavailable', new AppError('validation_failed', '域名不在系统域名列表内'));
  }
  if (actor.role === 'admin') return allow();
  // 可见性：只能认领对普通用户公开的域名（未公开的域名对普通用户等同不存在）
  if (!isDomainPublic(settings, domain)) {
    return block('domain_unavailable', new AppError('forbidden', '该域名未对普通用户开放'));
  }
  const policy = settings.mailbox_policy;
  // 保留前缀禁止认领（防冒充官方身份）
  if (policy.reservedLocalParts.includes(localPart)) {
    return block('reserved', new AppError('forbidden', `前缀 ${localPart} 为系统保留，无法认领`));
  }
  // 全局每用户认领上限（跨域名合计，防囤积）
  if (policy.perUserLimit > 0) {
    const owned = await db
      .select({ value: sql<number>`COUNT(*)` })
      .from(mailboxes)
      .where(eq(mailboxes.userId, actor.userId))
      .get();
    if ((owned?.value ?? 0) >= policy.perUserLimit) {
      return block('quota', new AppError('forbidden', `认领地址数已达上限（${policy.perUserLimit}）`));
    }
  }
  // 按域名上限：统计该用户在此域名下已认领数
  const domainLimit = domainPerUserLimit(settings, domain);
  if (domainLimit > 0) {
    const ownedInDomain = await db
      .select({ value: sql<number>`COUNT(*)` })
      .from(mailboxes)
      .where(and(eq(mailboxes.userId, actor.userId), eq(mailboxes.domain, domain)))
      .get();
    if ((ownedInDomain?.value ?? 0) >= domainLimit) {
      return block('domain_limit', new AppError('forbidden', `在该域名下最多认领 ${domainLimit} 个地址`));
    }
  }
  return allow(policy.perUserLimit, domainLimit);
}

/** 认领地址：domain 必须 ∈ 系统域名，address 全局唯一，普通用户受保留前缀/配额限制 */
export async function claimMailbox(
  env: Env,
  userId: number,
  role: Role,
  req: ClaimMailboxRequest,
): Promise<Mailbox> {
  const settings = await getSettingsFresh(env);
  const db = createDb(env);
  const policy = await evaluateClaimPolicy(db, settings, { userId, role }, req.localPart, req.domain);
  if (policy.blocked) throw policy.blocked.error;
  const { perUserLimit, perDomainLimit } = policy;

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
  const result = await db.update(mailboxes).set({ displayName })
    .where(and(eq(mailboxes.id, id), eq(mailboxes.userId, row.userId))).run();
  if (!result.meta.changes) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
  const [updated] = await db
    .select({ mailbox: mailboxes, messageCount: messageCountSql })
    .from(mailboxes)
    .where(eq(mailboxes.id, id))
    .all();
  return serialize(updated!.mailbox, Number(updated!.messageCount));
}

/** 不经过释放/重新认领：所有权、审计及旧共享撤销在同一个 D1 事务内完成。 */
export async function transferMailbox(
  env: Env,
  actor: Pick<AuthUser, 'id' | 'username' | 'role'>,
  id: number,
  req: TransferMailboxRequest,
  ip = '',
): Promise<MailboxTransferResult> {
  if (actor.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const db = createDb(env);
  const row = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!row) throw new AppError('not_found', '邮箱不存在');
  const target = await db.select().from(users).where(eq(users.id, req.userId)).get();
  if (!target) throw new AppError('not_found', '目标用户不存在');
  if (target.status !== 'active') throw new AppError('validation_failed', '只能过户给启用中的用户');
  const resultFor = async (box: MailboxRow, transferred: boolean, revokedShares = 0): Promise<MailboxTransferResult> => {
    const count = await db.select({ value: sql<number>`COUNT(*)` }).from(messages).where(eq(messages.address, box.address)).get();
    return { mailbox: serialize(box, Number(count?.value ?? 0), target.username),
      previousUserId: transferred ? row.userId : box.userId, transferred, revokedShares };
  };
  // 重试已完成的过户不清理新主人后来建立的共享，也不重复记审计。
  if (row.userId === target.id) return resultFor(row, false);
  if (row.userId !== req.expectedOwnerId) throw new AppError('conflict', '邮箱归属已改变，请刷新后重新确认');
  const previous = await db.select({ username: users.username }).from(users).where(eq(users.id, row.userId)).get();
  const detail = `${previous?.username ?? `user#${row.userId}`} (#${row.userId}) → ${target.username} (#${target.id})；保留全部历史并撤销旧共享`;
  const results = await env.db.batch([
    env.db.prepare(`UPDATE mailboxes SET user_id = ? WHERE id = ? AND user_id = ? AND user_id <> ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')`)
      .bind(target.id, id, req.expectedOwnerId, target.id, target.id),
    // changes() 关联事务内紧邻的上一条写入；CAS 失败时后续审计和共享删除均不执行。
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?, ?, 'mailbox.transfer', ?, ?, ? WHERE changes() = 1`)
      .bind(actor.id, actor.username, row.address, detail, ip),
    env.db.prepare('DELETE FROM mailbox_shares WHERE mailbox_id = ? AND changes() = 1').bind(id),
  ]);
  const updated = await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get();
  if (!updated) throw new AppError('not_found', '邮箱已被释放，请刷新后重试');
  if (!results[0]?.meta.changes) {
    if (updated.userId === target.id) return resultFor(updated, false);
    throw new AppError('conflict', '邮箱归属或目标用户状态已改变，请刷新后重新确认');
  }
  // 返回本次提交的结果；若另一管理员随后再次过户，客户端读回列表即可发现。
  return resultFor({ ...row, userId: target.id }, true, results[2]?.meta.changes ?? 0);
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
  statements.push(env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id = ?
    AND EXISTS (SELECT 1 FROM mailboxes WHERE id = ? AND user_id = ?)`).bind(row.id, row.id, row.userId));
  statements.push(env.db.prepare('DELETE FROM mailboxes WHERE id = ? AND user_id = ?').bind(row.id, row.userId));
  // One D1 transaction includes every message present at release, including concurrent inbound.
  const result = await env.db.batch(statements);
  if (!result[result.length - 1]?.meta.changes) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
  const deletedMessages = deleteHistory ? (result[1 + PURGE_MESSAGES_INDEX]?.meta.changes ?? 0) : 0;
  if (deleteHistory) await processStorageCleanup(env, 100);
  return { deletedMessages };
}

/** 可用性提示：与认领同一套规则（evaluateClaimPolicy），不可用时给出 reason；不预订地址 */
export async function checkAvailability(
  env: Env,
  actor: { userId: number; role: Role },
  localPart: string,
  domain: string,
): Promise<MailboxAvailability> {
  const address = `${localPart}@${domain}`;
  const db = createDb(env);
  const policy = await evaluateClaimPolicy(db, await getSettingsFresh(env), actor, localPart, domain);
  if (policy.blocked) return { address, available: false, reason: policy.blocked.reason };
  const existing = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get();
  return existing ? { address, available: false, reason: 'taken' } : { address, available: true };
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

/** 通知归属：已认领 → 主人；未认领 → 全部启用中的管理员。收信当时结算，一次查询完成。 */
export async function resolveNotifyOwnerIds(env: Env, address: string): Promise<number[]> {
  const rows = await env.db.prepare(`SELECT user_id AS id FROM mailboxes WHERE address = ?1
    UNION ALL
    SELECT id FROM users WHERE role = 'admin' AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1)`).bind(address).all<{ id: number }>();
  return rows.results.map((row) => Number(row.id));
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
