import type {
  ListMessagesQuery,
  MessageDetail,
  MessageRecipients,
  MessageSummary,
  Page,
  Role,
} from '@hpc-mail/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, mailboxes, messages, stars } from '../db/schema.js';
import { signAttachment } from '../lib/crypto.js';
import { chunk, D1_PAIR_BATCH } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';
import { resolveVerificationCode } from './code-extract.js';
import { deleteMessageObjects, getJson } from './storage.js';

export interface Viewer {
  userId: number;
  role: Role;
  scope?: 'mine' | 'unclaimed' | 'user';
  /** admin + scope=user 时的目标用户 */
  targetUserId?: number;
}

type MessageRow = typeof messages.$inferSelect;

/** 可见范围：未认领地址，或限定为某用户认领的地址集合（以 mailboxes 子查询表达，不展开成数组） */
type Scope = 'unclaimed' | { ownerId: number };

function assertAdminScope(viewer: Viewer): void {
  if (viewer.role === 'admin') return;
  if (viewer.scope === 'unclaimed' || viewer.scope === 'user') {
    throw new AppError('forbidden', '无权使用该可见范围');
  }
}

/** 解析列表/只读可见范围：admin 缺省 = 自己认领，不再默认全表 */
function resolveScope(viewer: Viewer): Scope {
  assertAdminScope(viewer);
  if (viewer.role === 'admin' && viewer.scope === 'unclaimed') return 'unclaimed';
  if (viewer.role === 'admin' && viewer.scope === 'user') {
    if (!viewer.targetUserId) throw new AppError('validation_failed', '查看指定用户邮件需要 userId');
    return { ownerId: viewer.targetUserId };
  }
  return { ownerId: viewer.userId };
}

/**
 * 变更类操作的可见范围：admin 必须显式 scope='unclaimed' 才动未认领地址；
 * 不能改其他用户已认领的邮件。漏传则只作用自己。
 */
function resolveMutationScope(viewer: Viewer): Scope {
  assertAdminScope(viewer);
  if (viewer.role === 'admin' && viewer.scope === 'user') {
    throw new AppError('forbidden', '不能修改其他用户的邮件');
  }
  if (viewer.role === 'admin' && viewer.scope === 'unclaimed') return 'unclaimed';
  return { ownerId: viewer.userId };
}

/**
 * 可见范围 SQL 条件：用 mailboxes 子查询而非把地址展开成 IN (?,?,…)。
 * D1 单条查询最多 100 个绑定参数，展开时认领地址一多就会整条语句被拒；
 * 子查询无论认领多少地址都只占 1 个绑定值（ownerId），顺带省掉一次 userAddresses 查询。
 */
function scopeCondition(db: Db, scope: Scope): SQL {
  if (scope === 'unclaimed') {
    return notInArray(messages.address, db.select({ address: mailboxes.address }).from(mailboxes));
  }
  return inArray(
    messages.address,
    db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, scope.ownerId)),
  );
}



function summarize(row: MessageRow, hasAttachments: boolean, isStarred: boolean): MessageSummary {
  const verificationCode = resolveVerificationCode(
    row.subject,
    row.bodyText || htmlToText(row.bodyHtml),
    row.verificationCode,
  );
  return {
    id: row.id,
    direction: row.direction,
    address: row.address,
    domain: row.domain,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    preview: row.preview,
    verificationCode,
    status: row.status,
    errorDetail: row.errorDetail ?? '',
    recipientsTo: row.direction === 'outbound' ? (row.recipients?.to ?? []) : undefined,
    isRead: row.isRead,
    isStarred,
    hasAttachments,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}

async function attachmentFlags(db: Db, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  // 一页最多 MAX_PAGE_SIZE=100 个 id，正好顶到 D1 绑定参数上限，必须分批
  for (const batch of chunk(ids)) {
    const rows = await db
      .select({ messageId: attachmentsTable.messageId })
      .from(attachmentsTable)
      .where(inArray(attachmentsTable.messageId, batch))
      .all();
    for (const r of rows) out.add(r.messageId);
  }
  return out;
}

/** 当前用户对给定邮件集合的星标标记 */
async function starFlags(db: Db, userId: number, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (const batch of chunk(ids)) {
    const rows = await db
      .select({ messageId: stars.messageId })
      .from(stars)
      .where(and(eq(stars.userId, userId), inArray(stars.messageId, batch)))
      .all();
    for (const r of rows) out.add(r.messageId);
  }
  return out;
}

export async function listMessages(
  env: Env,
  viewer: Viewer,
  query: ListMessagesQuery,
): Promise<Page<MessageSummary>> {
  const db = createDb(env);
  const scope = resolveScope(viewer);

  const conds: (SQL | undefined)[] = [scopeCondition(db, scope)];
  // 回收站视图看软删除的，普通视图排除软删除的
  conds.push(query.trash ? isNotNull(messages.deletedAt) : isNull(messages.deletedAt));
  if (query.direction) conds.push(eq(messages.direction, query.direction));
  if (query.domain) conds.push(eq(messages.domain, query.domain));
  if (query.address) conds.push(eq(messages.address, query.address));
  if (query.unread) conds.push(eq(messages.isRead, false));
  if (query.starred) {
    conds.push(
      inArray(
        messages.id,
        db.select({ id: stars.messageId }).from(stars).where(eq(stars.userId, viewer.userId)),
      ),
    );
  }
  if (query.q) {
    // 转义 LIKE 通配符（% _ \），否则用户搜 "50%" 会变成任意匹配；配 ESCAPE 子句生效
    const escaped = query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const term = `%${escaped}%`;
    conds.push(
      or(
        sql`${messages.subject} LIKE ${term} ESCAPE '\\'`,
        sql`${messages.fromAddress} LIKE ${term} ESCAPE '\\'`,
        sql`${messages.fromName} LIKE ${term} ESCAPE '\\'`,
        sql`${messages.bodyText} LIKE ${term} ESCAPE '\\'`,
        // recipients 存的是 JSON 文本，对其 LIKE 即可按收件人搜索（已发送找「发给谁」）
        sql`${messages.recipients} LIKE ${term} ESCAPE '\\'`,
      ),
    );
  }
  const cursorId = decodeCursor(query.cursor);
  if (cursorId) conds.push(lt(messages.id, cursorId));
  if (query.afterId) conds.push(gt(messages.id, query.afterId));

  const where = and(...conds.filter((x): x is SQL => x !== undefined));
  const rows = await db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.id))
    .limit(query.limit + 1)
    .all();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const ids = page.map((r) => r.id);
  const [attSet, starSet] = await Promise.all([
    attachmentFlags(db, ids),
    starFlags(db, viewer.userId, ids),
  ]);

  return {
    items: page.map((r) => summarize(r, attSet.has(r.id), starSet.has(r.id))),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}

/**
 * 收件箱未读数：口径同 /inbox（scope=mine + inbound + 未读），一条 COUNT 查询。
 * 复用 listMessages 的可见性逻辑（resolveScope/scopeCondition），避免条件漂移；
 * admin 也按 scope=mine 只数自己认领地址（个人角标，非全站）。
 */
export async function countUnread(env: Env, userId: number, role: Role): Promise<number> {
  const db = createDb(env);
  const scope = resolveScope({ userId, role, scope: 'mine' });
  const row = await db
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        scopeCondition(db, scope),
        eq(messages.direction, 'inbound'),
        eq(messages.isRead, false),
        isNull(messages.deletedAt),
      ),
    )
    .get();
  return row?.value ?? 0;
}

/** 近期联系人：从可见邮件聚合收件人(outbound)与发件人(inbound)地址，供写信自动补全 */
export async function getRecentContacts(env: Env, viewer: Viewer, limit = 100): Promise<string[]> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const rows = await db
    .select({
      direction: messages.direction,
      recipients: messages.recipients,
      fromAddress: messages.fromAddress,
    })
    .from(messages)
    .where(and(scopeCondition(db, scope), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(400)
    .all();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.direction === 'outbound') {
      for (const addr of [...(r.recipients?.to ?? []), ...(r.recipients?.cc ?? [])]) {
        if (addr) seen.add(addr);
      }
    } else if (r.fromAddress) {
      seen.add(r.fromAddress);
    }
    if (seen.size >= limit) break;
  }
  return [...seen].slice(0, limit);
}

/** 归一化主题：剥离 Re:/Fwd:/回复:/转发: 前缀，用于会话归组 */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|回复|转发)\s*[:：]\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/** 会话线程：同一归一化主题、可见范围内的邮件，按时间正序 */
export async function getThread(env: Env, viewer: Viewer, id: number): Promise<MessageSummary[]> {
  const db = createDb(env);
  const target = await loadVisible(env, viewer, id);
  const core = normalizeSubject(target.subject);
  const summarizeRows = async (rows: MessageRow[]) => {
    const ids = rows.map((r) => r.id);
    const [attSet, starSet] = await Promise.all([
      attachmentFlags(db, ids),
      starFlags(db, viewer.userId, ids),
    ]);
    return rows.map((r) => summarize(r, attSet.has(r.id), starSet.has(r.id)));
  };
  if (!core) return summarizeRows([target]);

  const scope = await threadScope(db, viewer, target);
  const escaped = core.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        scopeCondition(db, scope),
        isNull(messages.deletedAt),
        sql`${messages.subject} LIKE ${`%${escaped}%`} ESCAPE '\\'`,
      ),
    )
    .orderBy(asc(messages.id))
    .limit(100)
    .all();
  const thread = rows.filter((r) => normalizeSubject(r.subject) === core);
  return summarizeRows(thread.length ? thread : [target]);
}

async function isAddressClaimed(db: Db, address: string): Promise<boolean> {
  const row = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get();
  return row !== undefined;
}

/**
 * 单封可见性：
 * - scope=unclaimed → 仅未认领
 * - scope=user → 仅该用户认领
 * - 其余（含 admin 裸开无 query）→ 自己认领；admin 无 scope 时额外允许未认领
 */
async function loadVisible(env: Env, viewer: Viewer, id: number): Promise<MessageRow> {
  const db = createDb(env);
  const row = await db.select().from(messages).where(eq(messages.id, id)).get();
  if (!row) throw new AppError('not_found', '邮件不存在');
  const scope = resolveScope(viewer);
  if (scope === 'unclaimed') {
    if (await isAddressClaimed(db, row.address)) throw new AppError('not_found', '邮件不存在');
    return row;
  }
  const owned = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, scope.ownerId), eq(mailboxes.address, row.address)))
    .get();
  if (owned) return row;
  if (viewer.role === 'admin' && viewer.scope === undefined && !(await isAddressClaimed(db, row.address))) {
    return row;
  }
  throw new AppError('not_found', '邮件不存在');
}

/** 详情线程跟目标邮件同一可见桶，避免 admin 裸开未认领信时线程掉回「自己认领」 */
async function threadScope(db: Db, viewer: Viewer, target: MessageRow): Promise<Scope> {
  const scope = resolveScope(viewer);
  if (scope === 'unclaimed') return 'unclaimed';
  if (viewer.role === 'admin' && viewer.scope === undefined && !(await isAddressClaimed(db, target.address))) {
    return 'unclaimed';
  }
  return scope;
}

function rewriteCidUrls(
  html: string,
  atts: { contentId: string; url: string }[],
): string {
  let result = html;
  for (const att of atts) {
    if (!att.contentId) continue;
    const escaped = att.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`cid:${escaped}`, 'gi'), att.url);
  }
  return result;
}

export async function getMessageDetail(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<MessageDetail> {
  const db = createDb(env);
  const row = await loadVisible(env, viewer, id);

  let bodyText = row.bodyText;
  let bodyHtml = row.bodyHtml;
  if (row.bodyR2Key) {
    const full = await getJson<{ text?: string; html?: string }>(env, row.bodyR2Key);
    if (full) {
      bodyText = full.text ?? bodyText;
      bodyHtml = full.html ?? bodyHtml;
    }
  }

  const [attRows, starSet] = await Promise.all([
    db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, id)).all(),
    starFlags(db, viewer.userId, [id]),
  ]);

  const attachmentMetas = await Promise.all(
    attRows.map(async (a) => {
      const { exp, sig } = await signAttachment(env.jwt_secret, a.id);
      return {
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentId: a.contentId,
        disposition: a.disposition,
        url: `/api/attachments/${a.id}?exp=${exp}&sig=${sig}`,
      };
    }),
  );

  bodyHtml = rewriteCidUrls(
    bodyHtml,
    attachmentMetas.map((a) => ({ contentId: a.contentId, url: a.url })),
  );

  return {
    ...summarize(row, attRows.length > 0, starSet.has(id)),
    verificationCode: resolveVerificationCode(
      row.subject,
      bodyText || htmlToText(bodyHtml),
      row.verificationCode,
    ),
    recipients: row.recipients as MessageRecipients,
    bodyText,
    bodyHtml,
    attachments: attachmentMetas,
    hasRaw: !!row.rawR2Key,
  };
}

/** 取原始 .eml R2 对象（校验可见性）；无存档返回 null */
export async function getRawMessageObject(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<R2ObjectBody | null> {
  const row = await loadVisible(env, viewer, id);
  if (!row.rawR2Key) return null;
  return env.r2.get(row.rawR2Key);
}

/** 加载单条附件（校验可见性由调用方决定：签名 URL 或 JWT） */
export async function loadAttachmentForViewer(
  env: Env,
  viewer: Viewer,
  attId: number,
): Promise<typeof attachmentsTable.$inferSelect> {
  const db = createDb(env);
  const att = await db.select().from(attachmentsTable).where(eq(attachmentsTable.id, attId)).get();
  if (!att) throw new AppError('not_found', '附件不存在');
  await loadVisible(env, viewer, att.messageId);
  return att;
}

export async function loadAttachmentById(
  env: Env,
  attId: number,
): Promise<typeof attachmentsTable.$inferSelect> {
  const db = createDb(env);
  const att = await db.select().from(attachmentsTable).where(eq(attachmentsTable.id, attId)).get();
  if (!att) throw new AppError('not_found', '附件不存在');
  return att;
}

/** 批量已读/未读（按可见范围过滤） */
export async function markMessages(
  env: Env,
  viewer: Viewer,
  ids: number[],
  isRead: boolean,
): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  // ids 分批：D1 单条查询最多 100 个绑定参数，schema 允许一次传 500 个 id
  let changed = 0;
  for (const batch of chunk(ids)) {
    const cond = and(inArray(messages.id, batch), scopeCondition(db, scope));
    const result = await db.update(messages).set({ isRead }).where(cond).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}

/** 收件箱一键全读：可见范围内全部未读 inbound 标为已读（不含回收站） */
export async function markAllRead(env: Env, viewer: Viewer): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  const result = await db
    .update(messages)
    .set({ isRead: true })
    .where(
      and(
        scopeCondition(db, scope),
        eq(messages.direction, 'inbound'),
        eq(messages.isRead, false),
        isNull(messages.deletedAt),
      ),
    )
    .run();
  return result.meta.changes ?? 0;
}

/** 批量星标/取消（每用户独立；限可见范围） */
export async function starMessages(
  env: Env,
  viewer: Viewer,
  ids: number[],
  starred: boolean,
): Promise<number> {
  const db = createDb(env);
  // 星标是个人标记（独立 stars 表，不影响他人），用只读可见范围即可
  const scope = resolveScope(viewer);
  const visibleIds: number[] = [];
  for (const batch of chunk(ids)) {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(inArray(messages.id, batch), scopeCondition(db, scope)))
      .all();
    visibleIds.push(...rows.map((v) => v.id));
  }
  if (visibleIds.length === 0) return 0;

  if (starred) {
    // 每行 2 个绑定参数（userId + messageId），批次相应减半
    for (const batch of chunk(visibleIds, D1_PAIR_BATCH)) {
      await db
        .insert(stars)
        .values(batch.map((id) => ({ userId: viewer.userId, messageId: id })))
        .onConflictDoNothing();
    }
  } else {
    for (const batch of chunk(visibleIds)) {
      await db
        .delete(stars)
        .where(and(eq(stars.userId, viewer.userId), inArray(stars.messageId, batch)));
    }
  }
  return visibleIds.length;
}

function scopedIdsCondition(db: Db, scope: Scope, ids: number[]): SQL {
  return and(inArray(messages.id, ids), scopeCondition(db, scope)) as SQL;
}

/** 批量软删除（移入回收站）：仅置 deletedAt，7 天后由 scheduled 硬删 */
export async function deleteMessages(env: Env, viewer: Viewer, ids: number[]): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  const deletedAt = new Date();
  let changed = 0;
  for (const batch of chunk(ids)) {
    const cond = and(scopedIdsCondition(db, scope, batch), isNull(messages.deletedAt)) as SQL;
    const result = await db.update(messages).set({ deletedAt }).where(cond).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}

/** 从回收站恢复：清空 deletedAt */
export async function restoreMessages(env: Env, viewer: Viewer, ids: number[]): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  let changed = 0;
  for (const batch of chunk(ids)) {
    const cond = and(scopedIdsCondition(db, scope, batch), isNotNull(messages.deletedAt)) as SQL;
    const result = await db.update(messages).set({ deletedAt: null }).where(cond).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}

/** 永久删除（可见范围内）：D1 行删 + R2 清理（正文/附件/原始 .eml） */
export async function purgeMessages(env: Env, viewer: Viewer, ids: number[]): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  const targets: { id: number; bodyR2Key: string | null; rawR2Key: string | null }[] = [];
  for (const batch of chunk(ids)) {
    const rows = await db
      .select({ id: messages.id, bodyR2Key: messages.bodyR2Key, rawR2Key: messages.rawR2Key })
      .from(messages)
      .where(scopedIdsCondition(db, scope, batch))
      .all();
    targets.push(...rows);
  }
  if (targets.length === 0) return 0;
  const targetIds = targets.map((t) => t.id);
  // 先删 R2 再删 D1：反过来的话，删除中途中断（CPU 超时等）就留下一批没有任何行指向的
  // R2 对象，再也定位不到；这个顺序下中断只会留下指向空对象的 D1 行，下次清理还能扫到重试
  for (const t of targets) {
    await deleteMessageObjects(env, t.id, t.bodyR2Key);
    if (t.rawR2Key) {
      try {
        await env.r2.delete(t.rawR2Key);
      } catch (e) {
        console.error('删除原始邮件对象失败:', e);
      }
    }
  }
  for (const batch of chunk(targetIds)) {
    await db.delete(attachmentsTable).where(inArray(attachmentsTable.messageId, batch));
    await db.delete(stars).where(inArray(stars.messageId, batch));
    await db.delete(messages).where(inArray(messages.id, batch));
  }
  return targetIds.length;
}
