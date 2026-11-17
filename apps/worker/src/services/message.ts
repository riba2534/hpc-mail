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
import { COUNTS_AS_ATTACHMENT, countsAsAttachment } from '../lib/attachment-rule.js';
import { decodeCursor, encodeCursor, pageHead } from '../lib/pagination.js';
import { detectPromptInjection, extractReplyText } from '../lib/agent-text.js';
import { mailText, PREVIEW_LIMIT } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { isAiModelConfigured } from './ai-provider.js';
import { resolveVerificationCode } from './code-extract.js';
import { getSettings } from './setting.js';
import { readMailBody } from './mail-body.js';
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
  | 'auth'
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
  auth: messages.auth,
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
 * domain 收窄：认领/共享范围是小地址集合，应沿地址索引逐个找；裸 domain = ? 会让规划器改走
 * idx_messages_domain 扫完整个 catch-all 域。一元 + 不改值，只让该条件不参与选索引。
 * 未认领范围没有地址集合可走，交给规划器。
 */
function domainCondition(scope: Scope, domain: string): SQL {
  return scope === 'unclaimed' ? eq(messages.domain, domain) : sql`+${messages.domain} = ${domain}`;
}

/**
 * mailboxes 按域名收窄时写成一元 +domain，不让它参与选索引：始终按 user_id（或共享关系）只读调用者自己的邮箱行，
 * 不会改走 idx_mailboxes_domain 读出全站该域的认领行
 */
const mailboxOnDomain = (domain: string | undefined) => (domain ? sql`+${mailboxes.domain} = ${domain}` : undefined);

/** 分享给 userId、且认领人仍启用的地址；给了 domain 时只取该域的 */
function sharedAddressQuery(db: Db, userId: number, domain?: string) {
  return db
    .select({ address: mailboxes.address })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(eq(mailboxShares.userId, userId), eq(users.status, 'active'), mailboxOnDomain(domain)));
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
 * 只用于已限定「inbound + 未删除」的查询（wait）：可见地址集合 = 认领 ∪ 分享，用 UNION ALL 代替 OR。
 * 分享分支本身要求 inbound + 未删除，外层条件已覆盖，语义与 scopeCondition 一致；
 * 去掉 OR 后地址集合是唯一的 IN 条件，INDEXED BY 才能逐个地址取数，而不是扫全站未删除邮件。
 * 邮箱不能共享给自己的所有者，两支不相交，不需要 UNION 去重的临时 B 树（每个地址省一行读取）。
 * 给了 domain 时在子查询里先收窄到该域的地址，逐地址探查的次数只随该域的可见地址数增长。
 */
function inboxScopeCondition(db: Db, scope: Scope, access: ScopeAccess, domain?: string): SQL {
  if (scope === 'unclaimed') return scopeCondition(db, scope, access);
  const owned = db.select({ address: mailboxes.address }).from(mailboxes)
    .where(and(eq(mailboxes.userId, scope.ownerId), mailboxOnDomain(domain)));
  if (access === 'owned') return inArray(messages.address, owned);
  return inArray(messages.address, unionAll(owned, sharedAddressQuery(db, scope.ownerId, domain)));
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
 * 能走地址索引时返回地址所属用户：看自己的邮件，且不是回收站、不带 domain/星标/搜索。
 * 这几个条件要回表才能判断，逐个地址扫到凑满 LIMIT 会读出地址下的大部分邮件（10 万封基准里
 * admin 的 domain/星标视图读取量反增 26–125 倍），保持原计划；未认领与审计他人邮箱同样保持原计划。
 */
function addressIndexOwner(viewer: Viewer, scope: Scope, query: { trash?: boolean; domain?: string; starred?: boolean; q?: string }): number | null {
  if (scope === 'unclaimed' || scope.ownerId !== viewer.userId) return null;
  if (query.trash || query.domain || query.starred || query.q) return null;
  return scope.ownerId;
}

/**
 * 地址索引写法的可见范围。readable 写成「地址 ∈ 认领 ∪ 共享」且「收件或认领地址」，
 * 在外层已限定未删除时与 scopeCondition 的 owned OR (inbound AND shared) 等价；
 * 地址集合成为唯一的 IN 条件，INDEXED BY 才能逐个地址取数（OR 形式只能整索引扫描）。
 */
function addressIndexScope(db: Db, ownerId: number, access: ScopeAccess): SQL {
  const owned = () => db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, ownerId));
  if (access === 'owned') return inArray(messages.address, owned());
  return and(
    inArray(messages.address, union(owned(), sharedAddressQuery(db, ownerId))),
    or(eq(messages.direction, 'inbound'), inArray(messages.address, owned())),
  ) as SQL;
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
  const prefix: SQL[] = [];
  if (!query.direction) prefix.push(inArray(messages.direction, [...MESSAGE_DIRECTIONS]));
  if (!query.unread) prefix.push(inArray(messages.isRead, [false, true]));
  return { from: MESSAGES_BY_VISIBLE, prefix };
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
    // 收件才有认证结果；null 表示没有可信结果（历史邮件、站内互投），与「认证失败」不同
    auth: row.direction === 'inbound' ? (row.auth ?? null) : undefined,
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

/** 给定邮件集合的附件标记与当前用户的星标标记，合成一次 batch 往返 */
async function messageFlags(db: Db, userId: number, ids: number[]): Promise<{ attachments: Set<number>; starred: Set<number> }> {
  const attachments = new Set<number>();
  const starred = new Set<number>();
  // 一页最多 MAX_PAGE_SIZE=100 个 id，正好顶到 D1 绑定参数上限，必须分批
  const batches = chunk(ids);
  const statements = [
    ...batches.map((batch) => db.select({ messageId: attachmentsTable.messageId }).from(attachmentsTable)
      .where(and(inArray(attachmentsTable.messageId, batch), COUNTS_AS_ATTACHMENT))),
    ...batches.map((batch) => db.select({ messageId: stars.messageId }).from(stars)
      .where(and(eq(stars.userId, userId), inArray(stars.messageId, batch)))),
  ];
  const [first, ...rest] = statements;
  if (!first) return { attachments, starred };
  const results = await db.batch([first, ...rest]);
  results.forEach((rows, index) => {
    const target = index < batches.length ? attachments : starred;
    for (const row of rows) target.add(row.messageId);
  });
  return { attachments, starred };
}

/**
 * 列表搜索语义（主题/发件地址/发件名/正文/收件人子串）；全部已读按同一语义收窄。
 * 正文只搜 D1 的 body_text：正文前 BODY_PREVIEW_BYTES 的纯文本，只有 HTML 的邮件为 HTML 转出的文字（mail-body.ts）；
 * 尚未回填的旧行仍是完整文本段。
 */
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
type PageRow = { [K in keyof typeof pageColumns]: (typeof pageColumns)[K]['_']['type'] };

/** 列表页查询（不执行）：列表与 sync 共用同一条语句，两边的 head 才基于同一份数据 */
function messagePageQuery(db: Db, viewer: Viewer, query: ListMessagesQuery) {
  const scope = resolveScope(viewer);
  const access = listAccess(viewer, scope, query);
  const ownerId = addressIndexOwner(viewer, scope, query);
  const source = ownerId === null ? { from: MESSAGES, prefix: [] } : addressIndexSource(query);

  const conds: (SQL | undefined)[] = [ownerId === null ? scopeCondition(db, scope, access) : addressIndexScope(db, ownerId, access)];
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
  conds.push(...source.prefix);

  const where = and(...conds.filter((x): x is SQL => x !== undefined));
  return db
    .select(pageColumns)
    .from(source.from)
    .where(where)
    .orderBy(desc(messages.id))
    .limit(query.limit + 1);
}

async function toPage(db: Db, viewer: Viewer, query: ListMessagesQuery, rows: PageRow[]): Promise<Page<MessageSummary>> {
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const flags = await messageFlags(db, viewer.userId, page.map((r) => r.id));
  return {
    items: page.map((r) => {
      const summary = summarize(r, flags.attachments.has(r.id), flags.starred.has(r.id));
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
  return toPage(db, viewer, query, await messagePageQuery(db, viewer, query).all());
}

/**
 * 列表轻量轮询：调用者自己的未读数（同 /unread-count，封顶）+ 该筛选下首页的 head 指纹。
 * cursor/afterId 忽略，limit 决定首页大小；未读数与首页同一次 batch 读出，再加一次标记查询，
 * 往返次数与列表首页相同。
 */
export async function syncMessages(env: Env, viewer: Viewer, query: ListMessagesQuery): Promise<MessageSyncResult> {
  const db = createDb(env);
  const firstPage: ListMessagesQuery = { ...query, cursor: undefined, afterId: undefined };
  const [unread, rows] = await db.batch([
    unreadCountQuery(db, viewer.userId, viewer.role, UNREAD_COUNT_CAP),
    messagePageQuery(db, viewer, firstPage),
  ]);
  const page = await toPage(db, viewer, firstPage, rows);
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
/** 指定地址时 FROM 带 INDEXED BY（写成 SQL），列也要用同名 SQL 列 */
const waitColumns = asSqlColumns(summarySelection);
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
 * 读整行时带上本查询的同一组范围条件复核，与附件、星标合成一次 batch，不再走详情的可见性校验。
 */
export async function findNextMessage(
  env: Env,
  viewer: Viewer,
  input: { afterId: number; address?: string[]; domain?: string; include?: 'body' } & WaitFilters,
  attachmentTtlSeconds?: number,
): Promise<WaitMessageResult> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const conditions: SQL[] = [
    inboxScopeCondition(db, scope, shareAccess(viewer, scope), input.domain),
    eq(messages.direction, 'inbound'),
    isNull(messages.deletedAt),
    gt(messages.id, input.afterId),
  ];
  if (input.address) conditions.push(inArray(messages.address, input.address));
  if (input.domain) conditions.push(domainCondition(scope, input.domain));
  const filtered = Boolean(input.from || input.subjectContains || input.hasCode);
  // 指定地址、或范围是自己/某用户的可见地址（domain 已并进地址子查询）时，逐个地址按 id 取：
  // 否则规划器为省排序沿 idx_messages_live 扫全站 afterId 之后的邮件，没有新信的轮询（最常见）每次都要读完这段。
  // 逐地址的读取量约为调用方的邮箱行数 + 每个可见地址两行（物化与探查）+ 这些地址的新信；原计划物化地址子查询
  // 同样要读邮箱行和每个地址一行，所以地址再多也只比原计划的下限多每地址一行（至多约 1.5 倍），且不再随全站新信增长，
  // 不设地址数上限、不回退。
  // 未认领范围的地址集合不可枚举：只给 domain 时交给规划器走 idx_messages_domain（该域的新信），什么都不给时仍按 id 扫全站新信
  const byAddress = Boolean(input.address) || scope !== 'unclaimed';
  const rows = await db
    .select(waitColumns)
    .from(byAddress ? MESSAGES_BY_ADDRESS : MESSAGES)
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
    // 发件人与主题收件时就已确定，不匹配的 pending 行照常跳过；匹配的要等附件落库再返回
    if (row.status === 'pending' && Date.now() - row.createdAt.getTime() < PENDING_ATTACHMENTS_GRACE_MS) break;
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
    if (input.include === 'body') {
      // 两次读取之间被删除、移入回收站或失去可见性（共享撤销、释放、过户）的不再以详情返回：
      // 它已不在等待范围内，游标越过它继续往后找
      const [[full], attRows, starRows] = await db.batch([
        db.select().from(messages).where(and(eq(messages.id, row.id), ...conditions)), ...detailExtras(db, viewer.userId, row.id),
      ]);
      if (!full) { scannedThroughId = row.id; continue; }
      const body = await readMailBody(env, full);
      return { message: await buildDetail(env, full, body, attRows, starRows.length > 0, attachmentTtlSeconds), scannedThroughId: row.id };
    }
    const flags = await messageFlags(db, viewer.userId, [row.id]);
    return { message: { ...summary, hasAttachments: flags.attachments.has(row.id), isStarred: flags.starred.has(row.id) }, scannedThroughId: row.id };
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
  // 联系人只看自己认领的地址（owned），自己的邮箱同样按地址取最近 400 封
  const ownerId = addressIndexOwner(viewer, scope, {});
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
/** 除正文外的全部列，ETag 由它们计算（正文变化必然伴随 status、body_r2_key 等列变化） */
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

/** 主题与完整正文（可见性同详情），供翻译等只需要文字内容的读取 */
export async function getMessageContent(
  env: Env,
  viewer: Viewer,
  id: number,
): Promise<{ subject: string; bodyText: string; bodyHtml: string }> {
  const row = await loadVisible(env, viewer, id);
  return { subject: row.subject, ...(await readMailBody(env, row)) };
}

/** 详情所需的附件全行与当前用户星标，调用方放进同一次 batch */
function detailExtras(db: Db, userId: number, id: number) {
  return [
    db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, id)),
    db.select({ messageId: stars.messageId }).from(stars).where(and(eq(stars.userId, userId), eq(stars.messageId, id))),
  ] as const;
}

/** 由已确认可见的整行与完整正文（readMailBody）组装详情：附件签名 URL、CID 内联图替换 */
async function buildDetail(
  env: Env,
  row: MessageRow,
  body: { bodyText: string; bodyHtml: string },
  attRows: (typeof attachmentsTable.$inferSelect)[],
  starred: boolean,
  attachmentTtlSeconds?: number,
): Promise<MessageDetail> {
  const signed = await Promise.all(attRows.map(async (a) => {
    const { exp, sig } = await signAttachment(env.jwt_secret, a.id, attachmentTtlSeconds);
    return { ...a, url: `/api/attachments/${a.id}?exp=${exp}&sig=${sig}` };
  }));
  const { html, inlined } = rewriteCidUrls(body.bodyHtml, signed);
  // 给 Agent 的收件预处理在读取时惰性计算，不占收件链路的 CPU；HTML-only 邮件才需要转换
  const plain = row.direction === 'inbound' ? mailText(body.bodyText, body.bodyHtml).plain : '';
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
    ...(row.direction === 'inbound'
      ? { extractedText: extractReplyText(plain), risk: detectPromptInjection(row.subject, plain) }
      : {}),
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
 * 邮件详情：整行、可见性、星标一条语句，附件一条，同一个 D1 batch；完整正文再从 R2 读（readMailBody）。
 * attachmentTtlSeconds 不传时附件与 CID 内联图的签名按整点对齐（站内页面，1–2 小时）；
 * /v1 传短 TTL，签名 URL 不能比 Key 本身的有效期拖得更久。
 * 带 If-None-Match 且 ETag 一致时返回 notModified：只有这一次 D1 往返，不读 R2 正文。
 */
export async function getMessageDetailConditional(
  env: Env,
  viewer: Viewer,
  id: number,
  options: { attachmentTtlSeconds?: number; ifNoneMatch?: string | null } = {},
): Promise<ConditionalDetail> {
  const db = createDb(env);
  const scope = resolveScope(viewer);
  const [[row], attRows] = await db.batch([
    db.select({ ...messageColumns, ...visibilityColumns(viewer, scope), isStarred: starredColumn(viewer.userId) })
      .from(messages).where(eq(messages.id, id)),
    db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, id)).orderBy(asc(attachmentsTable.id)),
  ]);
  if (!row || !isVisible(viewer, scope, row, row)) throw new AppError('not_found', '邮件不存在');
  const etag = await detailEtag(env, viewer, row, attRows, row.isStarred, options.attachmentTtlSeconds);
  if (etagMatches(options.ifNoneMatch, etag)) return { etag, notModified: true };
  const body = await readMailBody(env, row);
  const detail = await buildDetail(env, row, body, attRows, row.isStarred, options.attachmentTtlSeconds);
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
export async function purgeMessages(env: Env, viewer: Viewer, ids: number[], ctx?: ExecCtx | null): Promise<number> {
  const db = createDb(env);
  const scope = resolveMutationScope(viewer);
  let changed = 0;
  for (const batch of chunk(ids)) {
    changed += await purgeMatchingMessages(env, and(scopedIdsCondition(db, scope, batch), isNotNull(messages.deletedAt))!, batch.length, ctx);
  }
  return changed;
}
