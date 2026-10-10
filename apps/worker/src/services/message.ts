import type {
  ListMessagesQuery,
  MarkAllReadRequest,
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
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { union } from 'drizzle-orm/sqlite-core';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, mailboxShares, mailboxes, messages, stars, users } from '../db/schema.js';
import { signAttachment } from '../lib/crypto.js';
import { chunk, D1_PAIR_BATCH } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';
import { isAiModelConfigured } from './ai-provider.js';
import { CODE_SCAN_BODY_CHARS, resolveVerificationCode } from './code-extract.js';
import { getSettings } from './setting.js';
import { getJson } from './storage.js';
import { purgeMatchingMessages } from './message-lifecycle.js';

export interface Viewer {
  userId: number;
  role: Role;
  scope?: 'mine' | 'unclaimed' | 'user';
  /** admin + scope=user 时的目标用户 */
  targetUserId?: number;
}

type MessageRow = typeof messages.$inferSelect;
type MessageSummaryRow = Pick<
  MessageRow,
  | 'id'
  | 'direction'
  | 'address'
  | 'domain'
  | 'fromAddress'
  | 'fromName'
  | 'recipients'
  | 'subject'
  | 'preview'
  | 'verificationCode'
  | 'verificationLink'
  | 'status'
  | 'errorDetail'
  | 'recipientOutcomes'
  | 'isRead'
  | 'size'
  | 'createdAt'
>;

const summarySelection = {
  id: messages.id,
  direction: messages.direction,
  address: messages.address,
  domain: messages.domain,
  fromAddress: messages.fromAddress,
  fromName: messages.fromName,
  recipients: messages.recipients,
  subject: messages.subject,
  preview: messages.preview,
  verificationCode: messages.verificationCode,
  verificationLink: messages.verificationLink,
  status: messages.status,
  errorDetail: messages.errorDetail,
  recipientOutcomes: messages.recipientOutcomes,
  isRead: messages.isRead,
  size: messages.size,
  createdAt: messages.createdAt,
};

/** 线程只需摘要与邮件头，不读正文列 */
const threadSelection = {
  ...summarySelection,
  messageId: messages.messageId,
  inReplyTo: messages.inReplyTo,
  references: messages.references,
  deletedAt: messages.deletedAt,
};
type ThreadRow = MessageSummaryRow & Pick<MessageRow, 'messageId' | 'inReplyTo' | 'references' | 'deletedAt'>;

/** 单封可见性判定所需的最少列 */
type VisibilityRow = Pick<MessageRow, 'address' | 'direction' | 'deletedAt'>;

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

/** 分享只加进「看自己的信」。审计他人、未认领、回收站、已发送仍只认领地址。 */
type ScopeAccess = 'owned' | 'readable';

function shareAccess(viewer: Viewer, scope: Scope): ScopeAccess {
  if (scope !== 'unclaimed' && scope.ownerId === viewer.userId) return 'readable';
  return 'owned';
}

/** 共享邮件的已读状态属于所有者：「未读」筛选与未读数一样只看自己认领的地址 */
function listAccess(viewer: Viewer, scope: Scope, query: { trash?: boolean; direction?: string; unread?: boolean }): ScopeAccess {
  if (shareAccess(viewer, scope) === 'owned') return 'owned';
  if (query.trash || query.direction === 'outbound' || query.unread) return 'owned';
  return 'readable';
}

/**
 * domain 收窄：认领/共享范围是小地址集合，应沿地址索引逐个找；裸 domain = ? 会让规划器改走
 * idx_messages_domain 扫完整个 catch-all 域。一元 + 不改值，只让该条件不参与选索引。
 * 未认领范围没有地址集合可走，交给规划器。
 */
function domainCondition(scope: Scope, domain: string): SQL {
  return scope === 'unclaimed' ? eq(messages.domain, domain) : sql`+${messages.domain} = ${domain}`;
}

/** 分享给 userId、且认领人仍是启用中管理员的地址 */
function sharedAddressQuery(db: Db, userId: number) {
  return db
    .select({ address: mailboxes.address })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(eq(mailboxShares.userId, userId), eq(users.role, 'admin'), eq(users.status, 'active')));
}

/**
 * 可见范围 SQL 条件：用子查询而非把地址展开成 IN (?,?,…)。
 * D1 单条查询最多 100 个绑定参数，展开时认领地址一多就会整条语句被拒。
 * readable = 自己认领的地址，再加上分享来的未删除收件。已发送和回收站不走 readable。
 */
function scopeCondition(db: Db, scope: Scope, access: ScopeAccess = 'owned'): SQL {
  if (scope === 'unclaimed') {
    return notInArray(messages.address, db.select({ address: mailboxes.address }).from(mailboxes));
  }
  const owned = inArray(
    messages.address,
    db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, scope.ownerId)),
  );
  if (access === 'owned') return owned;
  const sharedInbound = and(
    eq(messages.direction, 'inbound'),
    isNull(messages.deletedAt),
    inArray(messages.address, sharedAddressQuery(db, scope.ownerId)),
  );
  return or(owned, sharedInbound) ?? owned;
}

/**
 * 只用于已限定「inbound + 未删除」的查询：可见地址集合 = 认领 ∪ 分享，用 UNION 代替 OR。
 * 分享分支本身要求 inbound + 未删除，外层条件已覆盖，语义与 scopeCondition 一致；
 * 去掉 OR 后规划器才能按地址逐个走 idx_messages_visible，而不是扫全站未删除邮件。
 */
function inboxScopeCondition(db: Db, scope: Scope, access: ScopeAccess): SQL {
  if (scope === 'unclaimed' || access === 'owned') return scopeCondition(db, scope, access);
  const owned = db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, scope.ownerId));
  return inArray(messages.address, union(owned, sharedAddressQuery(db, scope.ownerId)));
}



export function summarize(row: MessageSummaryRow, hasAttachments: boolean, isStarred: boolean): MessageSummary {
  const verificationCode = resolveVerificationCode(
    row.subject,
    row.preview,
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
    verificationLink: row.verificationLink ?? '',
    status: row.status,
    errorDetail: row.errorDetail ?? '',
    recipientOutcomes: row.recipientOutcomes,
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

/** 列表搜索语义（主题/发件地址/发件名/文本正文/收件人子串）；全部已读按同一语义收窄 */
function searchCondition(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const term = q.toLowerCase();
  return or(
    sql`instr(lower(${messages.subject}), ${term}) > 0`,
    sql`instr(lower(${messages.fromAddress}), ${term}) > 0`,
    sql`instr(lower(${messages.fromName}), ${term}) > 0`,
    sql`instr(lower(${messages.bodyText}), ${term}) > 0`,
    sql`instr(lower(${messages.recipients}), ${term}) > 0`,
  );
}

export async function listMessages(
  env: Env,
  viewer: Viewer,
  query: ListMessagesQuery,
): Promise<Page<MessageSummary>> {
  const db = createDb(env);
  const scope = resolveScope(viewer);

  const conds: (SQL | undefined)[] = [scopeCondition(db, scope, listAccess(viewer, scope, query))];
  // 回收站视图看软删除的，普通视图排除软删除的
  conds.push(query.trash ? isNotNull(messages.deletedAt) : isNull(messages.deletedAt));
  if (query.direction) conds.push(eq(messages.direction, query.direction));
  if (query.domain) conds.push(domainCondition(scope, query.domain));
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
  conds.push(searchCondition(query.q));
  const cursorId = decodeCursor(query.cursor);
  if (cursorId) conds.push(lt(messages.id, cursorId));
  if (query.afterId) conds.push(gt(messages.id, query.afterId));

  const where = and(...conds.filter((x): x is SQL => x !== undefined));
  const rows = await db
    .select({ ...summarySelection, deletedAt: messages.deletedAt })
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
    items: page.map((r) => {
      const summary = summarize(r, attSet.has(r.id), starSet.has(r.id));
      // 回收站视图带上进入回收站的时间，前端据此计算剩余保留天数
      return query.trash && r.deletedAt ? { ...summary, deletedAt: r.deletedAt.toISOString() } : summary;
    }),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}

/** 长轮询过滤：发件人（完整地址或 `@域名`）、主题包含、已识别验证码 */
export interface WaitFilters {
  from?: string;
  subjectContains?: string;
  hasCode?: boolean;
}

/** 单次轮询最多检查的新邮件数；积压更多时由调用方用 scannedThroughId 继续推进 */
const WAIT_SCAN_BATCH = 50;
/** AI 兜底提码在收件后异步写回；这段时间内无码的新邮件先不判为「不匹配」，避免被跳过 */
const AI_CODE_GRACE_MS = 30_000;

/**
 * 增量读取严格返回 afterId 之后最早一封满足过滤条件的收件，保证游标推进时不会跳过突发邮件。
 * scannedThroughId 是本次已确定检查过的最大 id（没有新邮件时等于 afterId）：其间不匹配的邮件被跳过，
 * 调用方超时后可从它继续。hasCode 与返回的 verificationCode 同一口径；AI 可能稍后补码的新邮件
 * 不计入已检查，下一次轮询再判定。
 */
export async function findNextMessage(
  env: Env,
  viewer: Viewer,
  input: { afterId: number; address?: string } & WaitFilters,
): Promise<{ message: MessageSummary | null; scannedThroughId: number }> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const conditions: SQL[] = [
    inboxScopeCondition(db, scope, shareAccess(viewer, scope)),
    eq(messages.direction, 'inbound'),
    isNull(messages.deletedAt),
    gt(messages.id, input.afterId),
  ];
  if (input.address) conditions.push(eq(messages.address, input.address));
  const filtered = Boolean(input.from || input.subjectContains || input.hasCode);
  const rows = await db
    .select(summarySelection)
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.id))
    .limit(filtered ? WAIT_SCAN_BATCH : 1)
    .all();

  let aiPending: boolean | undefined;
  let scannedThroughId = input.afterId;
  for (const row of rows) {
    const subjectMatches = !input.subjectContains || row.subject.toLowerCase().includes(input.subjectContains.toLowerCase());
    if (!matchesSender(row.fromAddress, input.from) || !subjectMatches) {
      scannedThroughId = row.id;
      continue;
    }
    const summary = summarize(row, false, false);
    if (input.hasCode && !summary.verificationCode) {
      if (aiPending === undefined) {
        const settings = await getSettings(env);
        aiPending = settings.code_extract.enabled && settings.code_extract.aiEnabled && isAiModelConfigured(settings.ai_model);
      }
      if (aiPending && Date.now() - row.createdAt.getTime() < AI_CODE_GRACE_MS) break;
      scannedThroughId = row.id;
      continue;
    }
    const [attSet, starSet] = await Promise.all([
      attachmentFlags(db, [row.id]),
      starFlags(db, viewer.userId, [row.id]),
    ]);
    return { message: { ...summary, hasAttachments: attSet.has(row.id), isStarred: starSet.has(row.id) }, scannedThroughId: row.id };
  }
  return { message: null, scannedThroughId };
}

function matchesSender(fromAddress: string, filter: string | undefined): boolean {
  if (!filter) return true;
  const sender = fromAddress.toLowerCase();
  return filter.startsWith('@') ? sender.endsWith(filter) : sender === filter;
}

/**
 * 收件箱未读数：口径同 /inbox 的未读筛选（scope=mine + inbound + 未读），一条 COUNT 查询。
 * 只数自己认领的地址：共享邮件的已读状态属于所有者，成员改不了，也不计入成员的未读。
 * admin 也按 scope=mine 只数自己认领地址（个人角标，非全站）。
 */
export async function countUnread(env: Env, userId: number, role: Role): Promise<number> {
  const db = createDb(env);
  const viewer: Viewer = { userId, role, scope: 'mine' };
  const scope = resolveScope(viewer);
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

/** 回复/转发前缀：Re:/Fwd:/Fw:/回复:/转发:（全角冒号同样识别） */
const REPLY_PREFIX = /^\s*(?:re|fwd?|回复|转发)\s*[:：]/i;

/** 归一化主题：剥离 Re:/Fwd:/回复:/转发: 前缀，用于会话归组 */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|回复|转发)\s*[:：]\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/**
 * 会话线程：同一归一化主题、可见范围内的邮件，按时间正序。
 * 每轮先用 message_id / in_reply_to 两条各自走索引的子查询 UNION 出候选 id，
 * 再套未删除与可见性条件；原先 OR 叠加可见性 OR 会让规划器放弃索引、每轮扫全表并读出正文。
 */
export async function getThread(env: Env, viewer: Viewer, id: number): Promise<MessageSummary[]> {
  const db = createDb(env);
  const target = await db.select(threadSelection).from(messages).where(eq(messages.id, id)).get();
  if (!target) throw new AppError('not_found', '邮件不存在');
  await assertVisible(db, viewer, target);
  const summarizeRows = async (rows: ThreadRow[]) => {
    const ids = rows.map((r) => r.id);
    const [attSet, starSet] = await Promise.all([
      attachmentFlags(db, ids),
      starFlags(db, viewer.userId, ids),
    ]);
    return rows.map((r) => summarize(r, attSet.has(r.id), starSet.has(r.id)));
  };
  const scope = await threadScope(db, viewer, target);
  const access = shareAccess(viewer, scope);
  const related = new Map<number, ThreadRow>([[target.id, target]]);
  const messageKeys = new Set<string>();
  const addKeys = (row: ThreadRow) => {
    if (row.messageId) messageKeys.add(row.messageId);
    if (row.inReplyTo) messageKeys.add(row.inReplyTo);
    for (const ref of row.references.match(/<[^>]+>/g) ?? []) messageKeys.add(ref);
  };
  addKeys(target);

  // 优先按标准邮件头构建连通分量，最多扩展 10 轮/100 封，避免同主题邮件误合并。
  // 每批 40 个键在两条子查询里各绑定一次（80 个），加上可见性参数仍在 D1 的 100 个上限内。
  for (let round = 0; round < 10 && messageKeys.size > 0 && related.size < 100; round++) {
    let changed = false;
    for (const keys of chunk([...messageKeys], 40)) {
      const candidates = union(
        db.select({ id: messages.id }).from(messages).where(inArray(messages.messageId, keys)),
        db.select({ id: messages.id }).from(messages).where(inArray(messages.inReplyTo, keys)),
      );
      const rows = await db
        .select(threadSelection)
        .from(messages)
        .where(
          and(
            inArray(messages.id, candidates),
            isNull(messages.deletedAt),
            scopeCondition(db, scope, access),
          ),
        )
        .orderBy(asc(messages.id))
        .limit(100)
        .all();
      for (const row of rows) {
        if (related.has(row.id)) continue;
        related.set(row.id, row);
        addKeys(row);
        changed = true;
        if (related.size >= 100) break;
      }
    }
    if (!changed) break;
  }
  if (related.size > 1) {
    return summarizeRows([...related.values()].sort((a, b) => a.id - b.id));
  }

  // 主题回退只服务于缺线程头的回复/转发：验证码邮件常年同名（「Your code」），一律不按主题归并。
  const core = normalizeSubject(target.subject);
  if (!core || hasCode(target)) return summarizeRows([target]);

  const windowMs = 30 * 24 * 60 * 60 * 1000;
  const rows = await db
    .select(threadSelection)
    .from(messages)
    .where(
      and(
        scopeCondition(db, scope, access),
        isNull(messages.deletedAt),
        eq(messages.address, target.address),
        gte(messages.createdAt, new Date(target.createdAt.getTime() - windowMs)),
        lte(messages.createdAt, new Date(target.createdAt.getTime() + windowMs)),
        sql`instr(lower(${messages.subject}), ${core.toLowerCase()}) > 0`,
      ),
    )
    .orderBy(asc(messages.id))
    .limit(100)
    .all();
  // 两封里至少一封带 Re:/Fwd: 等前缀才算回复关系；两封都没前缀的同名邮件是彼此独立的邮件。
  const targetIsReply = hasReplyPrefix(target.subject);
  const thread = rows.filter((r) => r.id === target.id || (
    normalizeSubject(r.subject) === core && !hasCode(r) && (targetIsReply || hasReplyPrefix(r.subject))
  ));
  return summarizeRows(thread.length ? thread : [target]);
}

function hasReplyPrefix(subject: string): boolean {
  return REPLY_PREFIX.test(subject);
}

/** 与列表展示同一口径（读取时会重新校验已存验证码） */
function hasCode(row: Pick<MessageRow, 'subject' | 'preview' | 'verificationCode'>): boolean {
  return resolveVerificationCode(row.subject, row.preview, row.verificationCode) !== '';
}

async function isAddressClaimed(db: Db, address: string): Promise<boolean> {
  const row = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get();
  return row !== undefined;
}

/**
 * 单封可见性：
 * - scope=unclaimed → 仅未认领
 * - scope=user → 仅该用户认领
 * - 其余（含 admin 裸开无 query）→ 自己认领的地址，外加分享给自己的未删除收件
 * - admin 无 scope 时额外允许未认领
 */
async function assertVisible(db: Db, viewer: Viewer, row: VisibilityRow): Promise<void> {
  const scope = resolveScope(viewer);
  if (scope === 'unclaimed') {
    if (await isAddressClaimed(db, row.address)) throw new AppError('not_found', '邮件不存在');
    return;
  }
  const owned = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, scope.ownerId), eq(mailboxes.address, row.address)))
    .get();
  if (owned) return;
  if (shareAccess(viewer, scope) === 'readable' && row.direction === 'inbound' && row.deletedAt === null) {
    const shared = await db
      .select({ id: mailboxShares.mailboxId })
      .from(mailboxShares)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
      .innerJoin(users, eq(users.id, mailboxes.userId))
      .where(
        and(
          eq(mailboxShares.userId, scope.ownerId),
          eq(mailboxes.address, row.address),
          eq(users.role, 'admin'),
          eq(users.status, 'active'),
        ),
      )
      .get();
    if (shared) return;
  }
  if (viewer.role === 'admin' && viewer.scope === undefined && !(await isAddressClaimed(db, row.address))) {
    return;
  }
  throw new AppError('not_found', '邮件不存在');
}

/** 详情需要完整行（含正文）；只做可见性判定的调用方用 assertVisible 并自选列 */
async function loadVisible(env: Env, viewer: Viewer, id: number): Promise<MessageRow> {
  const db = createDb(env);
  const row = await db.select().from(messages).where(eq(messages.id, id)).get();
  if (!row) throw new AppError('not_found', '邮件不存在');
  await assertVisible(db, viewer, row);
  return row;
}

/** 详情线程跟目标邮件同一可见桶，避免 admin 裸开未认领信时线程掉回「自己认领」 */
async function threadScope(db: Db, viewer: Viewer, target: { address: string }): Promise<Scope> {
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

/** 完整正文：超过 D1 上限的正文在 R2，D1 里只有截断预览 */
async function fullBody(env: Env, row: Pick<MessageRow, 'bodyText' | 'bodyHtml' | 'bodyR2Key'>) {
  if (!row.bodyR2Key) return { bodyText: row.bodyText, bodyHtml: row.bodyHtml };
  const full = await getJson<{ text?: string; html?: string }>(env, row.bodyR2Key);
  return { bodyText: full?.text ?? row.bodyText, bodyHtml: full?.html ?? row.bodyHtml };
}

/** 主题与完整正文（可见性同详情），供翻译等只需要文字内容的读取 */
export async function getMessageContent(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<{ subject: string; bodyText: string; bodyHtml: string }> {
  const row = await loadVisible(env, viewer, id);
  return { subject: row.subject, ...(await fullBody(env, row)) };
}

export async function getMessageDetail(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<MessageDetail> {
  const db = createDb(env);
  const row = await loadVisible(env, viewer, id);

  const body = await fullBody(env, row);
  const bodyText = body.bodyText;
  let bodyHtml = body.bodyHtml;

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
    // 只看正文前 16KB：验证码总在开头附近，超长营销邮件不必每次打开都全文扫描
    verificationCode: resolveVerificationCode(
      row.subject,
      (bodyText || htmlToText(bodyHtml)).slice(0, CODE_SCAN_BODY_CHARS),
      row.verificationCode,
    ),
    recipients: row.recipients as MessageRecipients,
    replyTo: row.replyTo,
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
  const db = createDb(env);
  const row = await db
    .select({ address: messages.address, direction: messages.direction, deletedAt: messages.deletedAt, rawR2Key: messages.rawR2Key })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!row) throw new AppError('not_found', '邮件不存在');
  await assertVisible(db, viewer, row);
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
  const owner = await db
    .select({ address: messages.address, direction: messages.direction, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, att.messageId))
    .get();
  if (!owner) throw new AppError('not_found', '邮件不存在');
  await assertVisible(db, viewer, owner);
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

/**
 * 批量已读/未读：is_read 是邮件本身的状态，只能由认领人（或管理员对未认领）修改。
 * 分享来的邮件不在 owned 范围内，静默计 0，共享成员改不动所有者的已读状态。
 */
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

/**
 * 一键全读：范围内全部未读 inbound 标为已读（不含回收站），可按 domain/address/q 收窄，
 * q 与列表同一搜索语义。只处理自己认领的地址（admin scope=unclaimed 为未认领），共享邮件一律不动。
 * 范围仍是地址集合子查询，收窄条件只叠加在外层，保持走 idx_messages_visible。
 */
export async function markAllRead(
  env: Env,
  viewer: Viewer,
  filters: Omit<MarkAllReadRequest, 'scope'> = {},
): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  const conds: (SQL | undefined)[] = [
    scopeCondition(db, scope),
    eq(messages.direction, 'inbound'),
    eq(messages.isRead, false),
    isNull(messages.deletedAt),
  ];
  if (filters.domain) conds.push(domainCondition(scope, filters.domain));
  if (filters.address) conds.push(eq(messages.address, filters.address));
  conds.push(searchCondition(filters.q));
  const result = await db
    .update(messages)
    .set({ isRead: true })
    .where(and(...conds.filter((x): x is SQL => x !== undefined)))
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
      .where(and(inArray(messages.id, batch), scopeCondition(db, scope, shareAccess(viewer, scope))))
      .all();
    visibleIds.push(...rows.map((v) => v.id));
  }
  if (visibleIds.length === 0) return 0;

  let changed = 0;
  if (starred) {
    // 每行 2 个绑定参数（userId + messageId），批次相应减半
    for (const batch of chunk(visibleIds, D1_PAIR_BATCH)) {
      const result = await db.insert(stars)
        .values(batch.map((id) => ({ userId: viewer.userId, messageId: id })))
        .onConflictDoNothing().run();
      changed += result.meta.changes ?? 0;
    }
  } else {
    for (const batch of chunk(visibleIds)) {
      const result = await db.delete(stars)
        .where(and(eq(stars.userId, viewer.userId), inArray(stars.messageId, batch))).run();
      changed += result.meta.changes ?? 0;
    }
  }
  return changed;
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
    const cond = and(scopedIdsCondition(db, scope, batch), isNotNull(messages.deletedAt), isNull(messages.purgeToken)) as SQL;
    const result = await db.update(messages).set({ deletedAt: null }).where(cond).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}

/** 永久删除（可见范围内）：D1 行删 + R2 清理（正文/附件/原始 .eml） */
export async function purgeMessages(env: Env, viewer: Viewer, ids: number[]): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  let changed = 0;
  for (const batch of chunk(ids)) {
    changed += await purgeMatchingMessages(env, and(scopedIdsCondition(db, scope, batch), isNotNull(messages.deletedAt))!, batch.length);
  }
  return changed;
}
