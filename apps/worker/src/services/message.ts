import type {
  ListMessagesQuery,
  MarkAllReadRequest,
  MessageDetail,
  MessageRecipients,
  MessageSummary,
  MessageSyncResult,
  Page,
  Role,
  WaitMessageResult,
} from '@hpc-mail/shared';
import { MESSAGE_DIRECTIONS, UNREAD_COUNT_CAP } from '@hpc-mail/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
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
  type Column,
  type SQL,
} from 'drizzle-orm';
import { union, unionAll } from 'drizzle-orm/sqlite-core';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, mailboxShares, mailboxes, messages, stars, users } from '../db/schema.js';
import { ATTACHMENT_BUCKET_SECONDS, sha256Hex, signAttachment } from '../lib/crypto.js';
import { etagMatches } from '../lib/etag.js';
import { chunk, D1_PAIR_BATCH } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor, pageHead } from '../lib/pagination.js';
import { PREVIEW_LIMIT } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { isAiModelConfigured } from './ai-provider.js';
import { resolveVerificationCode } from './code-extract.js';
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
type ThreadRow = MessageSummaryRow & Pick<MessageRow, 'messageId' | 'inReplyTo' | 'references' | 'deletedAt'>
  & { hasAttachments: boolean; isStarred: boolean };

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
 * userId 认领的地址；给定 domain 时下推成 mailboxes.domain = ?（走 idx_mailboxes_user_domain）。
 * 收件、站内投递、外发、认领各写入路径里 messages.domain 与 mailboxes.domain 都取自地址本身的域名部分，
 * 按地址匹配到的邮件必然在该域，所以下推后 messages 上不再判断 domain：那一步要回表，逐地址取数时
 * 会把不在该域的地址下的邮件全部读一遍。未认领范围没有地址集合，仍在 messages 上按 domain 收窄。
 * userId 可以是 SQL：分流时写成 CASE WHEN … THEN userId END，条件不成立得 NULL，子查询为空。
 */
function ownedAddressQuery(db: Db, userId: number | SQL, domain?: string) {
  return db.select({ address: mailboxes.address }).from(mailboxes)
    .where(and(eq(mailboxes.userId, userId), domain === undefined ? undefined : eq(mailboxes.domain, domain)));
}

/**
 * 分享给 userId、且认领人仍启用的地址。domain 写成一元 +：裸 domain = ? 时规划器会改从
 * idx_mailboxes_domain 扫整个域再回查分享表，系统域名下有上千个地址；分享通常只有几个，从分享表出发。
 */
function sharedAddressQuery(db: Db, userId: number | SQL, domain?: string) {
  return db
    .select({ address: mailboxes.address })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(
      eq(mailboxShares.userId, userId), eq(users.status, 'active'),
      domain === undefined ? undefined : sql`+${mailboxes.domain} = ${domain}`,
    ));
}

/**
 * 可见范围 SQL 条件：用子查询而非把地址展开成 IN (?,?,…)。
 * D1 单条查询最多 100 个绑定参数，展开时认领地址一多就会整条语句被拒。
 * readable = 自己认领的地址，再加上分享来的未删除收件。已发送和回收站不走 readable。
 * domain 给定时按 ownedAddressQuery 的说明下推进地址子查询；未认领范围在 messages 上按 domain 收窄
 * （没有地址集合可走，交给规划器走 idx_messages_domain）。
 */
function scopeCondition(db: Db, scope: Scope, access: ScopeAccess = 'owned', domain?: string): SQL {
  if (scope === 'unclaimed') {
    return and(
      notInArray(messages.address, db.select({ address: mailboxes.address }).from(mailboxes)),
      domain === undefined ? undefined : eq(messages.domain, domain),
    ) as SQL;
  }
  const owned = inArray(messages.address, ownedAddressQuery(db, scope.ownerId, domain));
  if (access === 'owned') return owned;
  const sharedInbound = and(
    eq(messages.direction, 'inbound'),
    isNull(messages.deletedAt),
    inArray(messages.address, sharedAddressQuery(db, scope.ownerId, domain)),
  );
  return or(owned, sharedInbound) ?? owned;
}

/**
 * 只用于已限定「inbound + 未删除」的查询：可见地址集合 = 认领 ∪ 分享，用 UNION 代替 OR。
 * 分享分支本身要求 inbound + 未删除，外层条件已覆盖，语义与 scopeCondition 一致；
 * 去掉 OR 后规划器才能按地址逐个走 idx_messages_visible，而不是扫全站未删除邮件。gate 见 gatedOwner。
 */
function inboxScopeCondition(db: Db, scope: Scope, access: ScopeAccess, domain?: string, gate?: SQL): SQL {
  if (scope === 'unclaimed') return scopeCondition(db, scope, access, domain);
  const owner = gatedOwner(scope.ownerId, gate);
  if (access === 'owned') return inArray(messages.address, ownedAddressQuery(db, owner, domain));
  return inArray(messages.address, union(ownedAddressQuery(db, owner, domain), sharedAddressQuery(db, owner, domain)));
}

/**
 * 分流用：两条语句放进同一个 batch，逐地址那条的地址子查询按 gate 取 userId，gate 不成立时为 NULL、集合为空，
 * 整条语句只是一次空查找；另一条（原计划）在 gate 成立时把 id 区间压空。只有一条真正读邮件。
 */
function gatedOwner(ownerId: number, gate?: SQL): number | SQL {
  return gate ? sql`(CASE WHEN ${gate} THEN ${ownerId} END)` : ownerId;
}

/**
 * 默认视图（全部/收件/未读/已发送/按地址/翻页/联系人）强制按地址取数。
 * 无统计信息时规划器为省掉排序，会沿 idx_messages_live 按 id 倒扫全站未删除邮件，
 * 自己的邮件凑不满 LIMIT 的稀疏用户要扫到底；改为逐个可见地址按 id 倒序取，再合并排序，
 * 读取量只随自己的邮件量增长。按视图选索引见 addressIndexSource。
 */
const MESSAGES_BY_ADDRESS = sql`${messages} INDEXED BY idx_messages_address_deleted_id`;
const MESSAGES_BY_VISIBLE = sql`${messages} INDEXED BY idx_messages_visible`;
const MESSAGES = sql`${messages}`;

type ColumnValue<C extends Column> = C['_']['notNull'] extends true ? C['_']['data'] : C['_']['data'] | null;

/** FROM 写成 SQL（为了 INDEXED BY）时 drizzle 不接受列对象，改用同名 SQL 列并沿用列的解码 */
function asSqlColumns<T extends Record<string, Column>>(columns: T): { [K in keyof T]: SQL<ColumnValue<T[K]>> } {
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [key, sql`${column}`.mapWith(column)]),
  ) as { [K in keyof T]: SQL<ColumnValue<T[K]>> };
}

/**
 * 能走地址索引时返回地址所属用户：认领/共享范围，包括管理员审计他人邮箱（该用户认领的地址集合）。
 * 回收站与星标保持原计划：星标由 stars 子查询驱动按主键取，逐地址扫到凑满 LIMIT 会读出地址下的大部分邮件
 * （10 万封基准里 admin 的星标视图读取量反增 26–125 倍）；回收站只有软删除的少量邮件。未认领没有地址集合可走。
 * domain/搜索视图与审计他人另按地址数分流，见 messagePageQueries。
 */
function addressIndexOwner(scope: Scope, query: { trash?: boolean; starred?: boolean }): number | null {
  if (scope === 'unclaimed' || query.trash || query.starred) return null;
  return scope.ownerId;
}

/**
 * 地址索引写法的可见范围。readable 写成「地址 ∈ 认领 ∪ 共享」且「收件或认领地址」，
 * 在外层已限定未删除时与 scopeCondition 的 owned OR (inbound AND shared) 等价；
 * 地址集合成为唯一的 IN 条件，INDEXED BY 才能逐个地址取数（OR 形式只能整索引扫描）。
 * domain 下推进地址子查询（见 ownedAddressQuery）。gate 见 gatedOwner；「收件或认领地址」那一项
 * 只在遇到外发邮件时才求值，地址集合为空时不会遇到，不必再套。
 */
function addressIndexScope(db: Db, ownerId: number, access: ScopeAccess, domain?: string, gate?: SQL): SQL {
  const owner = gatedOwner(ownerId, gate);
  if (access === 'owned') return inArray(messages.address, ownedAddressQuery(db, owner, domain));
  return and(
    inArray(messages.address, union(ownedAddressQuery(db, owner, domain), sharedAddressQuery(db, owner, domain))),
    or(eq(messages.direction, 'inbound'), inArray(messages.address, ownedAddressQuery(db, ownerId, domain))),
  ) as SQL;
}

/**
 * domain/搜索视图与管理员审计他人按可见地址取数的地址数上限。逐地址取数每个地址至少要探 2–5 行（取到比当前
 * 第 LIMIT 名更旧的那一封才换下一个地址），读取量随地址数增长；原计划沿 idx_messages_live 按 id 倒扫全站、
 * 凑满 LIMIT 即停，读取量约为 LIMIT ÷ 自己的邮件在全站新邮件里的占比，邮件少的用户要扫完全站。
 * 本地 3 万封基准（列表首页 rows_read，改前 → 改后）：
 * - 3 个地址 + 3 个共享：domain 2.85 万 → 91，搜索 2.85 万 → 165–258；
 * - 35 个地址（占全站 3.5%）：domain 1130/6312 → 578/249，罕见词搜索 2.85 万 → 1251；
 * - 60 个地址（占 16%）：只有 20 个地址的域 818 → 463；40 个地址的域 394 → 657，上限附近两种取法互有胜负；
 *   搜索超过上限走原计划 702 → 890（多出的是分流判定）；
 * - 505 个地址（占 50%）：400 个地址的域走原计划 642 → 696（若逐地址取约 2900），只有 5 个地址的域 6498 → 240；
 * - 审计他人：505 个地址的用户 591 → 727（原计划），35 个地址的用户 987 → 516。
 * 判定数的是下推 domain 后的认领 + 共享地址数，LIMIT 上限 + 1，最多读 51 行；每条语句各判定一次。
 */
const ADDRESS_SCAN_MAX = 50;

/** 可见地址数（下推 domain 后）是否不超过 max。分享不复核认领人状态：只用来选取法，不影响结果。 */
function addressCountAtMost(db: Db, ownerId: number, access: ScopeAccess, domain: string | undefined, max: number): SQL {
  const owned = db.select({ one: sql`1` }).from(mailboxes)
    .where(and(eq(mailboxes.userId, ownerId), domain === undefined ? undefined : eq(mailboxes.domain, domain)));
  const set = access === 'owned' ? owned.limit(max + 1) : unionAll(owned, db.select({ one: sql`1` }).from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .where(and(eq(mailboxShares.userId, ownerId), domain === undefined ? undefined : sql`+${mailboxes.domain} = ${domain}`)))
    .limit(max + 1);
  return sql`(SELECT count(*) FROM ${set}) <= ${max}`;
}

/**
 * 按视图选地址索引：
 * - 带 direction 或未读筛选（收件/未读/已发送）走 idx_messages_visible(address, deleted_at, direction, is_read)。
 *   address_deleted_id 不含这两列，每封都要回表判断；主人邮件很多、匹配很少时（10 万封基准：主人 5.5 万封、
 *   3 封未读或 5 封已发送）要回表 5 万多次、本地 D1 约 90ms。visible 在索引内判断，未给出的 direction/is_read
 *   补成取遍全部取值的 IN（两列非空，只有 inbound/outbound 与 0/1，不改结果），等值前缀补齐后每个
 *  （地址, 方向, 已读）区间按 rowid 即 id 有序，取够 LIMIT 即停。
 * - 其余（全部/翻页/联系人）没有要回表的筛选，走 idx_messages_address_deleted_id，逐地址按 id 倒序取。
 */
function addressIndexSource(query: { direction?: string; unread?: boolean }): { from: SQL; prefix: SQL[] } {
  if (!query.direction && !query.unread) return { from: MESSAGES_BY_ADDRESS, prefix: [] };
  return { from: MESSAGES_BY_VISIBLE, prefix: visiblePrefix(query) };
}

/** idx_messages_visible 的等值前缀补齐：未给出的 direction/is_read 写成取遍全部取值的 IN */
function visiblePrefix(query: { direction?: string; unread?: boolean }): SQL[] {
  const prefix: SQL[] = [];
  if (!query.direction) prefix.push(inArray(messages.direction, [...MESSAGE_DIRECTIONS]));
  if (!query.unread) prefix.push(inArray(messages.isRead, [false, true]));
  return prefix;
}

export function summarize(row: MessageSummaryRow, hasAttachments: boolean, isStarred: boolean): MessageSummary {
  const verificationCode = resolveVerificationCode(
    row.subject,
    row.preview,
    row.verificationCode,
    // 摘要是截断文本：取满上限时末尾的候选可能被切短，别让它盖掉收件时存的完整码
    { bodyTruncated: row.preview.length >= PREVIEW_LIMIT },
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

/**
 * hasAttachments 的口径：带 Content-ID 的 inline 部件是正文里的内嵌图（logo、签名图），不算附件，
 * 否则带内嵌 logo 的通知邮件在列表里也显示回形针。JS 写法给详情，SQL 写法见 flagColumns，两处同一规则。
 */
function countsAsAttachment(att: { disposition: string; contentId: string }): boolean {
  return !(att.disposition === 'inline' && att.contentId !== '');
}

/**
 * 列表、sync、wait 行的附件与星标标记：相关子查询随行取回，不再取页后另查一次（少一次 D1 往返）。
 * 单表查询里 drizzle 把选择列中的列对象输出成不带表名的标识符，子查询里会被解析成内层表，
 * 所以外层写全限定名 "messages"."id"、内层用别名（同 visibilityColumns）。
 */
function flagColumns(userId: number) {
  return {
    hasAttachments: sql<boolean>`EXISTS (SELECT 1 FROM attachments AS flag_att
      WHERE flag_att.message_id = "messages"."id" AND NOT (flag_att.disposition = 'inline' AND flag_att.content_id <> ''))`
      .mapWith(Boolean),
    isStarred: starredColumn(userId),
  };
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

const pageColumns = asSqlColumns({ ...summarySelection, deletedAt: messages.deletedAt });

/**
 * 一条列表页语句：内层只按条件取 id、排序并截取 LIMIT，外层按 id 回表取列，附件与星标标记随行取回。
 * 走 idx_messages_visible 时内层的判断全在索引里完成，候选行一行都不读；原写法在排序前就为每个候选行
 * 物化整行（摘要列排在正文之后，正文大的行要读溢出页），标记子查询也会对每个候选行求值。
 * 外层只读最终的 LIMIT 行。
 */
function pageQuery(db: Db, viewer: Viewer, from: SQL, conds: (SQL | undefined)[], limit: number) {
  const ids = db.select({ id: sql`${messages.id}` }).from(from).where(and(...conds)).orderBy(desc(messages.id)).limit(limit + 1);
  return db.select({ ...pageColumns, ...flagColumns(viewer.userId) }).from(messages)
    .where(inArray(messages.id, ids)).orderBy(desc(messages.id));
}

type PageQuery = ReturnType<typeof pageQuery>;
type PageRow = Awaited<PageQuery>[number];

/**
 * 列表页语句（不执行）：列表与 sync 共用，两边的 head 才基于同一份数据。通常一条；按可见地址数分流时
 * 是两条（见 gatedOwner）：地址数 ≤ ADDRESS_SCAN_MAX 时逐地址那条读邮件，否则原计划那条读。
 */
function messagePageQueries(db: Db, viewer: Viewer, query: ListMessagesQuery): [PageQuery, ...PageQuery[]] {
  const scope = resolveScope(viewer);
  const access = listAccess(viewer, scope, query);
  const ownerId = addressIndexOwner(scope, query);
  const cursorId = decodeCursor(query.cursor);
  const filters: (SQL | undefined)[] = [
    // 回收站视图看软删除的，普通视图排除软删除的
    query.trash ? isNotNull(messages.deletedAt) : isNull(messages.deletedAt),
    query.direction ? eq(messages.direction, query.direction) : undefined,
    query.address ? eq(messages.address, query.address) : undefined,
    query.unread ? eq(messages.isRead, false) : undefined,
    query.starred
      ? inArray(messages.id, db.select({ id: stars.messageId }).from(stars).where(eq(stars.userId, viewer.userId)))
      : undefined,
    searchCondition(query.q),
    query.afterId ? gt(messages.id, query.afterId) : undefined,
  ];
  const planner = (before: SQL | undefined) =>
    pageQuery(db, viewer, MESSAGES, [scopeCondition(db, scope, access, query.domain), ...filters, before], query.limit);
  if (ownerId === null) return [planner(cursorId ? lt(messages.id, cursorId) : undefined)];

  const source = addressIndexSource(query);
  const byAddress = (gate?: SQL) => pageQuery(db, viewer, source.from, [
    addressIndexScope(db, ownerId, access, query.domain, gate), ...filters,
    cursorId ? lt(messages.id, cursorId) : undefined, ...source.prefix,
  ], query.limit);
  // 本人的默认视图与指定了单个地址的视图总是逐地址取；domain/搜索视图与管理员审计他人（原先都走原计划）
  // 按地址数分流，地址多时保持原计划（理由与实测见 ADDRESS_SCAN_MAX）
  const audit = ownerId !== viewer.userId;
  if ((!query.domain && !query.q && !audit) || query.address) return [byAddress()];
  const few = addressCountAtMost(db, ownerId, access, query.domain, ADDRESS_SCAN_MAX);
  return [
    byAddress(few),
    planner(lt(messages.id, sql`(CASE WHEN ${few} THEN 0 ELSE ${cursorId ?? Number.MAX_SAFE_INTEGER} END)`)),
  ];
}

function toPage(query: ListMessagesQuery, results: PageRow[][]): Page<MessageSummary> {
  // 分流的两条语句只有一条有结果，按 id 合并仍保证顺序
  const rows = results.length === 1 ? results[0]! : results.flat().sort((a, b) => b.id - a.id);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items: page.map((r) => {
      const summary = summarize(r, r.hasAttachments, r.isStarred);
      // 回收站视图带上进入回收站的时间，前端据此计算剩余保留天数
      return query.trash && r.deletedAt ? { ...summary, deletedAt: r.deletedAt.toISOString() } : summary;
    }),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}

export async function listMessages(
  env: Env,
  viewer: Viewer,
  query: ListMessagesQuery,
): Promise<Page<MessageSummary>> {
  const db = createDb(env);
  return toPage(query, await db.batch(messagePageQueries(db, viewer, query)));
}

/**
 * 列表轻量轮询：调用者自己的未读数（同 /unread-count，封顶）+ 该筛选下首页的 head 指纹。
 * cursor/afterId 忽略，limit 决定首页大小；未读数与首页（含标记）同一次 batch 读出，一次往返。
 */
export async function syncMessages(env: Env, viewer: Viewer, query: ListMessagesQuery): Promise<MessageSyncResult> {
  const db = createDb(env);
  const firstPage: ListMessagesQuery = { ...query, cursor: undefined, afterId: undefined };
  const [unread, ...pages] = await db.batch([
    unreadCountQuery(db, viewer.userId, viewer.role, UNREAD_COUNT_CAP),
    ...messagePageQueries(db, viewer, firstPage),
  ]);
  const page = toPage(firstPage, pages as PageRow[][]);
  return { unread: unread[0]?.value ?? 0, head: await pageHead(page) };
}

/** 长轮询过滤：发件人（完整地址或 `@域名`）、主题包含、已识别验证码 */
export interface WaitFilters {
  from?: string;
  subjectContains?: string;
  hasCode?: boolean;
}

/** 单次轮询最多检查的新邮件数；积压更多时由调用方用 scannedThroughId 继续推进 */
const WAIT_SCAN_BATCH = 50;
/** FROM 带 INDEXED BY（写成 SQL），列也要用同名 SQL 列 */
const waitColumns = asSqlColumns(summarySelection);
/**
 * 不指定地址的 wait 何时逐个可见地址取数。原计划沿 idx_messages_live 从 afterId 往后扫全站新邮件、
 * 遇到第一封可见的就停：游标跟得上时（每 2 秒轮询一次，最常见）只读一两行，逐地址取反而每个地址都要探一次
 * （本地 3 万封基准：505 个地址的用户没有新信时 1 → 3537 行）；但 afterId 落后很多（afterId=0 的空邮箱基线、
 * 中断后续等）且自己没有新信时，原计划每轮都要扫完 afterId 之后的全站邮件（空邮箱 afterId=0：28517 行）。
 * 所以只在 afterId 之后的全站新邮件多于 WAIT_SITE_SCAN_MAX 封、且可见地址不超过 ADDRESS_SCAN_MAX 个时逐地址取
 * （上例 179 行）；游标跟得上时分流判定只读到新邮件那几行（1 → 7 行），地址多的用户落后时多读约 200 行判定。
 */
const WAIT_SITE_SCAN_MAX = 50;

/** afterId 之后的全站未删除邮件是否多于 max 封（LIMIT max+1 计数，沿 idx_messages_live 只读索引） */
function newMailMoreThan(afterId: number, max: number): SQL {
  return sql`(SELECT count(*) FROM (SELECT 1 FROM messages AS wait_new INDEXED BY idx_messages_live
    WHERE wait_new.deleted_at IS NULL AND wait_new.id > ${afterId} LIMIT ${max + 1})) > ${max}`;
}
/** AI 兜底提码在收件后异步写回；这段时间内无码的新邮件先不判为「不匹配」，避免被跳过 */
const AI_CODE_GRACE_MS = 30_000;
/**
 * 带附件的收件先插 pending 行、附件落 R2 后才转为完整状态，正常几秒内完成。
 * 窗口内停在它之前等下一轮；超过窗口多半是附件保存失败在等 SMTP 重投，不再挡住后面的新邮件。
 */
const PENDING_ATTACHMENTS_GRACE_MS = 2 * 60_000;

/**
 * 增量读取严格返回 afterId 之后最早一封满足过滤条件的收件，保证游标推进时不会跳过突发邮件。
 * scannedThroughId 是本次已确定检查过的最大 id（没有新邮件时等于 afterId）：其间不匹配的邮件被跳过，
 * 调用方超时后可从它继续。hasCode 与返回的 verificationCode 同一口径；AI 可能稍后补码的新邮件、
 * 附件尚未落库（pending）的新邮件都不计入已检查，下一次轮询再判定——游标推过去调用方就再也看不到它。
 * address（多个地址）与 domain 在 SQL 里收窄，不参与「跳过」；include=body 时命中项返回与详情相同的结构，
 * 可见性已由本查询的范围条件确定，整行与附件、星标合成一次 batch，不再走详情的可见性校验。
 */
export async function findNextMessage(
  env: Env,
  viewer: Viewer,
  input: { afterId: number; address?: string[]; domain?: string; include?: 'body' } & WaitFilters,
  attachmentTtlSeconds?: number,
): Promise<WaitMessageResult> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const access = shareAccess(viewer, scope);
  const limit = input.from || input.subjectContains || input.hasCode ? WAIT_SCAN_BATCH : 1;
  const scan = (from: SQL, conditions: (SQL | undefined)[]) => db
    .select({ ...waitColumns, ...flagColumns(viewer.userId) })
    .from(from)
    .where(and(eq(messages.direction, 'inbound'), isNull(messages.deletedAt), ...conditions))
    .orderBy(asc(messages.id))
    .limit(limit);
  const after = gt(messages.id, input.afterId);
  let statements: [ReturnType<typeof scan>, ...ReturnType<typeof scan>[]];
  if (input.address) {
    // 指定地址时逐个地址按 id 取：多地址的 IN 会让规划器为省排序改沿 idx_messages_live 扫全站 afterId 之后的邮件
    statements = [scan(MESSAGES_BY_ADDRESS, [inboxScopeCondition(db, scope, access, input.domain), inArray(messages.address, input.address), after])];
  } else if (scope === 'unclaimed') {
    statements = [scan(MESSAGES, [inboxScopeCondition(db, scope, access, input.domain), after])];
  } else {
    const gate = sql`(${newMailMoreThan(input.afterId, WAIT_SITE_SCAN_MAX)} AND ${addressCountAtMost(db, scope.ownerId, access, input.domain, ADDRESS_SCAN_MAX)})`;
    statements = [
      scan(MESSAGES_BY_VISIBLE, [inboxScopeCondition(db, scope, access, input.domain, gate), after, ...visiblePrefix({ direction: 'inbound' })]),
      scan(MESSAGES, [inboxScopeCondition(db, scope, access, input.domain),
        gt(messages.id, sql`(CASE WHEN ${gate} THEN ${Number.MAX_SAFE_INTEGER} ELSE ${input.afterId} END)`)]),
    ];
  }
  const results = await db.batch(statements);
  // 分流的两条语句只有一条有结果
  const rows = results.length === 1 ? results[0] : results.flat().sort((x, y) => x.id - y.id).slice(0, limit);

  let aiPending: boolean | undefined;
  let scannedThroughId = input.afterId;
  for (const row of rows) {
    const subjectMatches = !input.subjectContains || row.subject.toLowerCase().includes(input.subjectContains.toLowerCase());
    if (!matchesSender(row.fromAddress, input.from) || !subjectMatches) {
      scannedThroughId = row.id;
      continue;
    }
    // 发件人与主题收件时就已确定，不匹配的 pending 行照常跳过；匹配的要等附件落库再返回
    if (row.status === 'pending' && Date.now() - row.createdAt.getTime() < PENDING_ATTACHMENTS_GRACE_MS) break;
    const summary = summarize(row, row.hasAttachments, row.isStarred);
    if (input.hasCode && !summary.verificationCode) {
      if (aiPending === undefined) {
        const settings = await getSettings(env);
        aiPending = settings.code_extract.enabled && settings.code_extract.aiEnabled && isAiModelConfigured(settings.ai_model);
      }
      if (aiPending && Date.now() - row.createdAt.getTime() < AI_CODE_GRACE_MS) break;
      scannedThroughId = row.id;
      continue;
    }
    if (input.include === 'body') {
      const [[full], attRows, starRows] = await db.batch([
        db.select().from(messages).where(eq(messages.id, row.id)), ...detailExtras(db, viewer.userId, row.id),
      ]);
      // 两次读取之间被永久删除：等同不存在，继续往后找
      if (!full) { scannedThroughId = row.id; continue; }
      return { message: await buildDetail(env, full, attRows, starRows.length > 0, attachmentTtlSeconds), scannedThroughId: row.id };
    }
    return { message: summary, scannedThroughId: row.id };
  }
  return { message: null, scannedThroughId };
}

function matchesSender(fromAddress: string, filter: string | undefined): boolean {
  if (!filter) return true;
  const sender = fromAddress.toLowerCase();
  return filter.startsWith('@') ? sender.endsWith(filter) : sender === filter;
}

/** /api 未读数封顶值在 @hpc-mail/shared，前后端共用；这里重新导出给路由 */
export { UNREAD_COUNT_CAP };

/**
 * 收件箱未读数：口径同 /inbox 的未读筛选（scope=mine + inbound + 未读），一条 COUNT 查询。
 * 只数自己认领的地址：共享邮件的已读状态属于所有者，成员改不了，也不计入成员的未读。
 * admin 也按 scope=mine 只数自己认领地址（个人角标，非全站）。
 * cap 给定时最多数到 cap 封即停（/api 角标），不给则精确计数（/v1 对外契约）。
 */
export async function countUnread(env: Env, userId: number, role: Role, cap?: number): Promise<number> {
  const row = await unreadCountQuery(createDb(env), userId, role, cap).get();
  return row?.value ?? 0;
}

function unreadCountQuery(db: Db, userId: number, role: Role, cap?: number) {
  const scope = resolveScope({ userId, role, scope: 'mine' });
  const where = and(
    scopeCondition(db, scope),
    eq(messages.direction, 'inbound'),
    eq(messages.isRead, false),
    isNull(messages.deletedAt),
  );
  if (cap === undefined) return db.select({ value: count() }).from(messages).where(where);
  const capped = db.select({ one: sql`1`.as('one') }).from(messages).where(where).limit(cap).as('capped');
  return db.select({ value: count() }).from(capped);
}

/** 近期联系人：从可见邮件聚合收件人(outbound)与发件人(inbound)地址，供写信自动补全 */
export async function getRecentContacts(env: Env, viewer: Viewer, limit = 100): Promise<string[]> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  // 联系人只看认领的地址（owned），同样按地址取最近 400 封
  const ownerId = addressIndexOwner(scope, {});
  const rows = await db
    .select(asSqlColumns({
      direction: messages.direction,
      recipients: messages.recipients,
      fromAddress: messages.fromAddress,
    }))
    .from(ownerId === null ? MESSAGES : MESSAGES_BY_ADDRESS)
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
 * 目标邮件与可见性判定同一条语句；附件与星标标记随行取回，不再单独查一次。
 */
export async function getThread(env: Env, viewer: Viewer, id: number): Promise<MessageSummary[]> {
  const db = createDb(env);
  const viewScope = resolveScope(viewer);
  const columns = threadColumns(viewer.userId);
  const target = await db
    .select({ ...columns, ...visibilityColumns(viewer, viewScope) })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!target || !isVisible(viewer, viewScope, target, target)) throw new AppError('not_found', '邮件不存在');
  const summarizeRows = (rows: ThreadRow[]) => rows.map((r) => summarize(r, r.hasAttachments, r.isStarred));
  // 线程跟目标邮件同一可见桶，避免 admin 裸开未认领信时线程掉回「自己认领」
  const scope: Scope = viewer.role === 'admin' && viewer.scope === undefined && !target.claimed ? 'unclaimed' : viewScope;
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
  // 每轮只查上一轮新出现的键（查过的键再查只会得到已收录的邮件），同一轮的各批合进一个 batch。
  // 每批 40 个键在两条子查询里各绑定一次（80 个），加上可见性参数仍在 D1 的 100 个上限内。
  const queried = new Set<string>();
  for (let round = 0; round < 10 && related.size < 100; round++) {
    const fresh = [...messageKeys].filter((key) => !queried.has(key));
    if (fresh.length === 0) break;
    for (const key of fresh) queried.add(key);
    const [first, ...rest] = chunk(fresh, 40).map((keys) => db
      .select(columns)
      .from(messages)
      .where(
        and(
          inArray(messages.id, union(
            db.select({ id: messages.id }).from(messages).where(inArray(messages.messageId, keys)),
            db.select({ id: messages.id }).from(messages).where(inArray(messages.inReplyTo, keys)),
          )),
          isNull(messages.deletedAt),
          scopeCondition(db, scope, access),
        ),
      )
      .orderBy(asc(messages.id))
      .limit(100));
    let changed = false;
    for (const rows of await db.batch([first!, ...rest])) {
      for (const row of rows) {
        if (related.size >= 100) break;
        if (related.has(row.id)) continue;
        related.set(row.id, row);
        addKeys(row);
        changed = true;
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
    .select(columns)
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
  return resolveVerificationCode(row.subject, row.preview, row.verificationCode, {
    bodyTruncated: row.preview.length >= PREVIEW_LIMIT,
  }) !== '';
}

/**
 * 单封可见性所需的三个事实，写成相关子查询与取行放进同一条语句：
 * owned = 地址属于范围所有者；shared = 地址共享给范围所有者且其认领人启用；claimed = 地址已被任何人认领。
 * 原先取行后依次查自有、共享、已认领，详情要 3–5 次串行往返；三个 EXISTS 各自走 mailboxes 的地址索引，
 * 用不上的那个也只是一次索引探测，换来详情、附件、原始邮件、线程、来源邮件都只需一次往返。
 * 外层 FROM 必须含 messages（或 JOIN 了 messages）。单表查询里 drizzle 输出不带表名的列，
 * 子查询里同名列会被解析成内层表（address = address 恒真），所以内外层一律写全限定名、内层用别名。
 */
function visibilityColumns(viewer: Viewer, scope: Scope) {
  const ownerId = scope === 'unclaimed' ? viewer.userId : scope.ownerId;
  return {
    owned: sql<boolean>`EXISTS (SELECT 1 FROM mailboxes AS vis_owned
      WHERE vis_owned.user_id = ${ownerId} AND vis_owned.address = "messages"."address")`.mapWith(Boolean),
    shared: sql<boolean>`EXISTS (SELECT 1 FROM mailbox_shares AS vis_share
      INNER JOIN mailboxes AS vis_mailbox ON vis_mailbox.id = vis_share.mailbox_id
      INNER JOIN users AS vis_owner ON vis_owner.id = vis_mailbox.user_id
      WHERE vis_share.user_id = ${ownerId} AND vis_mailbox.address = "messages"."address" AND vis_owner.status = 'active')`
      .mapWith(Boolean),
    claimed: sql<boolean>`EXISTS (SELECT 1 FROM mailboxes AS vis_claimed WHERE vis_claimed.address = "messages"."address")`
      .mapWith(Boolean),
  };
}

interface VisibilityFacts {
  owned: boolean;
  shared: boolean;
  claimed: boolean;
}

/**
 * 单封可见性（scope 由 resolveScope 解析）：
 * - scope=unclaimed → 仅未认领
 * - scope=user → 仅该用户认领
 * - 其余（含 admin 裸开无 query）→ 自己认领的地址，外加分享给自己的未删除收件
 * - admin 无 scope 时额外允许未认领
 */
function isVisible(viewer: Viewer, scope: Scope, row: VisibilityRow, facts: VisibilityFacts): boolean {
  if (scope === 'unclaimed') return !facts.claimed;
  if (facts.owned) return true;
  if (shareAccess(viewer, scope) === 'readable' && row.direction === 'inbound' && row.deletedAt === null && facts.shared) return true;
  return viewer.role === 'admin' && viewer.scope === undefined && !facts.claimed;
}

/**
 * 发信引用的来源邮件（转发附件、回复线程头）：与详情同一可见口径——发件人自己的 mine 范围
 * （认领 + 共享来的未删除收件），管理员另含未认领地址；不按角色整体放行，管理员也拿不到
 * 其他用户的私有邮件。不可见与不存在同为 404 source_unavailable，不暴露 id 是否存在；
 * 与发件邮箱不存在等 not_found 区分开，调用方据此去掉引用后可作为新邮件发送。
 * details.source 标明是哪一个引用不可用，同时带回复与转发时调用方据此只去掉对应的那个。
 */
export async function loadSourceMessage(
  env: Env,
  sender: { userId: number; role: Role },
  id: number,
  unavailableMessage: string,
  source: 'reply' | 'forward',
) {
  const db = createDb(env);
  const viewer: Viewer = { userId: sender.userId, role: sender.role };
  const scope = resolveScope(viewer);
  const row = await db
    .select({
      address: messages.address,
      direction: messages.direction,
      deletedAt: messages.deletedAt,
      messageId: messages.messageId,
      inReplyTo: messages.inReplyTo,
      references: messages.references,
      ...visibilityColumns(viewer, scope),
    })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!row || !isVisible(viewer, scope, row, row)) {
    throw new AppError('source_unavailable', unavailableMessage, { details: { source } });
  }
  return { address: row.address, direction: row.direction, deletedAt: row.deletedAt, messageId: row.messageId, inReplyTo: row.inReplyTo, references: row.references };
}

const messageColumns = getTableColumns(messages);
/** 除正文外的全部列：ETag 由它们计算，带 If-None-Match 的详情先只读这些，304 时不读正文 */
const metaColumns = Object.fromEntries(
  Object.entries(messageColumns).filter(([key]) => key !== 'bodyText' && key !== 'bodyHtml'),
) as Omit<typeof messageColumns, 'bodyText' | 'bodyHtml'>;

/** 当前用户是否星标该邮件（相关子查询，随行取回；全限定名的原因见 visibilityColumns） */
function starredColumn(userId: number) {
  return sql<boolean>`EXISTS (SELECT 1 FROM stars AS flag_star
    WHERE flag_star.user_id = ${userId} AND flag_star.message_id = "messages"."id")`.mapWith(Boolean);
}

/** 线程行：摘要列 + 邮件头 + 附件与星标标记；附件口径同 COUNTS_AS_ATTACHMENT（内嵌图不算附件） */
function threadColumns(userId: number) {
  return {
    ...threadSelection,
    hasAttachments: sql<boolean>`EXISTS (SELECT 1 FROM attachments AS flag_att
      WHERE flag_att.message_id = "messages"."id" AND NOT (flag_att.disposition = 'inline' AND flag_att.content_id <> ''))`
      .mapWith(Boolean),
    isStarred: starredColumn(userId),
  };
}

/**
 * 取一封可见邮件的整行（含正文）与可见性事实，一次往返；不可见与不存在同为 not_found。
 * 翻译等只需要文字内容的读取用它。
 */
async function loadVisible(env: Env, viewer: Viewer, id: number): Promise<MessageRow> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const row = await db
    .select({ ...messageColumns, ...visibilityColumns(viewer, scope) })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!row || !isVisible(viewer, scope, row, row)) throw new AppError('not_found', '邮件不存在');
  return row;
}

/**
 * 正文里的 cid: 引用一次扫描、解码后查表替换成签名 URL（与 attachment-links 同一写法）：
 * 逐个附件按前缀替换时 cid:img1 会先改坏 cid:img10。Content-ID 比较沿用原先的不区分大小写，
 * 重复的 Content-ID 取第一个附件。返回被引用并替换的附件 id，详情据此标 inline。
 */
function rewriteCidUrls(
  html: string,
  atts: { id: number; contentId: string; url: string }[],
): { html: string; inlined: Set<number> } {
  const byCid = new Map<string, { id: number; url: string }>();
  for (const att of atts) {
    const key = att.contentId.toLowerCase();
    if (key && !byCid.has(key)) byCid.set(key, att);
  }
  const inlined = new Set<number>();
  if (byCid.size === 0) return { html, inlined };
  const rewritten = html.replace(/cid:([^\s"'<>)]+)/gi, (original, cid: string) => {
    let decoded = cid;
    try { decoded = decodeURIComponent(cid); } catch { /* 保留原始 CID */ }
    const att = byCid.get(decoded.toLowerCase());
    if (!att) return original;
    inlined.add(att.id);
    return att.url;
  });
  return { html: rewritten, inlined };
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

/** 详情所需的附件全行与当前用户星标，调用方放进同一次 batch */
function detailExtras(db: Db, userId: number, id: number) {
  return [
    db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, id)),
    db.select({ messageId: stars.messageId }).from(stars).where(and(eq(stars.userId, userId), eq(stars.messageId, id))),
  ] as const;
}

/** 由已确认可见的整行组装详情：完整正文、附件签名 URL、CID 内联图替换 */
async function buildDetail(
  env: Env,
  row: MessageRow,
  attRows: (typeof attachmentsTable.$inferSelect)[],
  starred: boolean,
  attachmentTtlSeconds?: number,
): Promise<MessageDetail> {
  const [body, signed] = await Promise.all([
    fullBody(env, row),
    Promise.all(attRows.map(async (a) => {
      const { exp, sig } = await signAttachment(env.jwt_secret, a.id, attachmentTtlSeconds);
      return { ...a, url: `/api/attachments/${a.id}?exp=${exp}&sig=${sig}` };
    })),
  ]);
  const { html, inlined } = rewriteCidUrls(body.bodyHtml, signed);
  return {
    // 验证码与列表、wait、线程同一口径（summarize）：已存值优先，详情不再按正文另算一份
    ...summarize(row, attRows.some(countsAsAttachment), starred),
    recipients: row.recipients as MessageRecipients,
    replyTo: row.replyTo,
    bodyText: body.bodyText,
    bodyHtml: html,
    attachments: signed.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      contentId: a.contentId,
      disposition: a.disposition,
      inline: inlined.has(a.id),
      url: a.url,
    })),
    hasRaw: !!row.rawR2Key,
  };
}

/** /v1 详情的附件签名 URL 每次签发 5 分钟；ETag 按分钟分桶，304 复用的 URL 至少还剩 4 分钟 */
const SHORT_TTL_ETAG_BUCKET_SECONDS = 60;

/**
 * 详情的弱 ETag：除正文外的全部列（正文只随 status/body_r2_key 等列变化）、附件、当前用户星标、
 * 查看者与范围（同一 URL 不同用户看到的星标与可见性不同）、构建号（提码等读取规则随版本变化）。
 * 有附件时再加签名时间桶：站内签名按整点对齐，同一桶内 URL 不变；/v1 签名短，按分钟分桶。
 */
async function detailEtag(
  env: Env,
  viewer: Viewer,
  row: Record<string, unknown>,
  attRows: (typeof attachmentsTable.$inferSelect)[],
  starred: boolean,
  attachmentTtlSeconds: number | undefined,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const bucket = attRows.length === 0
    ? 0
    : Math.floor(now / (attachmentTtlSeconds === undefined ? ATTACHMENT_BUCKET_SECONDS : SHORT_TTL_ETAG_BUCKET_SECONDS));
  const meta = Object.keys(metaColumns).map((key) => row[key]);
  const digest = await sha256Hex(JSON.stringify([
    env.build_sha ?? 'local', viewer.userId, viewer.scope ?? '', viewer.targetUserId ?? 0, attachmentTtlSeconds ?? 0,
    bucket, starred, meta, attRows,
  ]));
  return `W/"${digest.slice(0, 32)}"`;
}

export type ConditionalDetail = { etag: string; notModified: true } | { etag: string; notModified: false; detail: MessageDetail };

/**
 * 邮件详情（一次往返：整行、可见性、星标一条语句，附件一条，同一 batch）。
 * attachmentTtlSeconds 不传时附件与 CID 内联图的签名按整点对齐（站内页面，1–2 小时）；
 * /v1 传短 TTL，签名 URL 不能比 Key 本身的有效期拖得更久。
 * 带 If-None-Match 时先不读正文：ETag 一致返回 notModified（仍是一次往返），不一致再补读正文。
 */
export async function getMessageDetailConditional(
  env: Env,
  viewer: Viewer,
  id: number,
  options: { attachmentTtlSeconds?: number; ifNoneMatch?: string | null } = {},
): Promise<ConditionalDetail> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const withBody = !options.ifNoneMatch;
  // CASE 的条件在执行时才求值，withBody=0 时正文列不会被读出
  const bodyColumn = (column: Column) => sql<string | null>`CASE WHEN ${withBody ? 1 : 0} = 1 THEN ${column} END`;
  const [[row], attRows] = await db.batch([
    db.select({
      ...metaColumns,
      bodyText: bodyColumn(messages.bodyText),
      bodyHtml: bodyColumn(messages.bodyHtml),
      ...visibilityColumns(viewer, scope),
      isStarred: starredColumn(viewer.userId),
    }).from(messages).where(eq(messages.id, id)),
    db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, id)).orderBy(asc(attachmentsTable.id)),
  ]);
  if (!row || !isVisible(viewer, scope, row, row)) throw new AppError('not_found', '邮件不存在');
  const etag = await detailEtag(env, viewer, row, attRows, row.isStarred, options.attachmentTtlSeconds);
  if (etagMatches(options.ifNoneMatch, etag)) return { etag, notModified: true };
  let body = { bodyText: row.bodyText ?? '', bodyHtml: row.bodyHtml ?? '' };
  if (!withBody) {
    const fetched = await db.select({ bodyText: messages.bodyText, bodyHtml: messages.bodyHtml }).from(messages).where(eq(messages.id, id)).get();
    // 两次读取之间被永久删除：与不存在一样
    if (!fetched) throw new AppError('not_found', '邮件不存在');
    body = fetched;
  }
  const detail = await buildDetail(env, { ...row, ...body }, attRows, row.isStarred, options.attachmentTtlSeconds);
  return { etag, notModified: false, detail };
}

/** 无条件读取详情（内部调用与测试用）；路由走 getMessageDetailConditional 以支持 304 */
export async function getMessageDetail(
  env: Env,
  viewer: Viewer,
  id: number,
  attachmentTtlSeconds?: number,
): Promise<MessageDetail> {
  const result = await getMessageDetailConditional(env, viewer, id, { attachmentTtlSeconds });
  if (result.notModified) throw new Error('unreachable: 无条件读取不会返回 304');
  return result.detail;
}

/** 取原始 .eml R2 对象（校验可见性，一次往返）；无存档返回 null */
export async function getRawMessageObject(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<R2ObjectBody | null> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const row = await db
    .select({
      address: messages.address, direction: messages.direction, deletedAt: messages.deletedAt, rawR2Key: messages.rawR2Key,
      ...visibilityColumns(viewer, scope),
    })
    .from(messages)
    .where(eq(messages.id, id))
    .get();
  if (!row || !isVisible(viewer, scope, row, row)) throw new AppError('not_found', '邮件不存在');
  if (!row.rawR2Key) return null;
  return env.r2.get(row.rawR2Key);
}

/** 加载单条附件并校验所属邮件对查看者可见：附件、所属邮件与可见性一条语句、一次往返 */
export async function loadAttachmentForViewer(
  env: Env,
  viewer: Viewer,
  attId: number,
): Promise<typeof attachmentsTable.$inferSelect> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const row = await db
    .select({
      attachment: getTableColumns(attachmentsTable),
      address: messages.address, direction: messages.direction, deletedAt: messages.deletedAt,
      ...visibilityColumns(viewer, scope),
    })
    .from(attachmentsTable)
    .leftJoin(messages, eq(messages.id, attachmentsTable.messageId))
    .where(eq(attachmentsTable.id, attId))
    .get();
  if (!row) throw new AppError('not_found', '附件不存在');
  if (row.address === null || row.direction === null) throw new AppError('not_found', '邮件不存在');
  if (!isVisible(viewer, scope, { address: row.address, direction: row.direction, deletedAt: row.deletedAt }, row)) {
    throw new AppError('not_found', '邮件不存在');
  }
  return row.attachment;
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
 * 范围是地址集合子查询（domain 下推进去），其余收窄条件叠加在外层，保持走 idx_messages_visible。
 */
export async function markAllRead(
  env: Env,
  viewer: Viewer,
  filters: Omit<MarkAllReadRequest, 'scope'> = {},
): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  const result = await db
    .update(messages)
    .set({ isRead: true })
    .where(and(
      scopeCondition(db, scope, 'owned', filters.domain),
      eq(messages.direction, 'inbound'),
      eq(messages.isRead, false),
      isNull(messages.deletedAt),
      filters.address ? eq(messages.address, filters.address) : undefined,
      searchCondition(filters.q),
    ))
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
export async function purgeMessages(env: Env, viewer: Viewer, ids: number[], ctx?: ExecCtx | null): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  let changed = 0;
  for (const batch of chunk(ids)) {
    changed += await purgeMatchingMessages(env, and(scopedIdsCondition(db, scope, batch), isNotNull(messages.deletedAt))!, batch.length, ctx);
  }
  return changed;
}
