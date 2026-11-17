import {
  HOSTED_DOMAIN_USABLE_STATUSES,
  type BatchClaimMailboxResult, type ClaimMailboxRequest, type ClaimPlanStrategy, type HostedDomainStatus, type Mailbox, type MailboxAvailability,
  type MailboxTransferResult, type MailboxUnavailableReason, type Page, type Role, type TransferMailboxRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { hostedDomains, mailboxes, messages, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { fetchLimit, toPage, type PageRequest } from '../lib/pagination.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import {
  claimSettingsStatement, mailboxPolicyUserFromResult, mailboxPolicyUserStatement, resolveMailboxPolicy,
  type ClaimSettings, type MailboxPolicyUser,
} from './mailbox-policy.js';
import { hostedSendBlock } from './domain.js';
import { getSettingsFresh, mergeSettingRows } from './setting.js';
import { purgeStatements } from './message-lifecycle.js';
import { scheduleStorageCleanup } from './storage-cleanup.js';
import { ACTOR_NAME_SQL, auditStatement, auditSuffix, type AuditActor } from './audit.js';

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

/** 列表项的发信判定所需列：托管域名 LEFT JOIN 进同一条查询，不多一次往返 */
const sendableColumns = { status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus };

/** 地址或所有者用户名包含 q（调用方已转小写；地址入库即为小写）：instr 按字面匹配，% 和 _ 不当通配符 */
export function mailboxSearchSql(q: string): SQL {
  return or(sql`instr(${mailboxes.address}, ${q}) > 0`,
    sql`${mailboxes.userId} IN (SELECT id FROM users WHERE instr(lower(username), ${q}) > 0)`)!;
}

export interface ListMailboxesOptions {
  userId?: number;
  all?: boolean;
  q?: string;
  domain?: string;
  /** API Key 限定范围：只列 id 在 mailboxIds 或域名在 domains 中的邮箱（两个列表各以一个 JSON 参数绑定） */
  restrict?: { mailboxIds: number[]; domains: string[] };
}

function restrictedMailboxes(restrict: ListMailboxesOptions['restrict']): SQL | undefined {
  if (!restrict) return undefined;
  return or(
    sql`${mailboxes.id} IN (SELECT value FROM json_each(${JSON.stringify(restrict.mailboxIds)}))`,
    sql`${mailboxes.domain} IN (SELECT value FROM json_each(${JSON.stringify(restrict.domains)}))`,
  );
}

/**
 * 本人或全站（all）邮箱，按 id 倒序。page 为 null 时返回完整数组（旧行为）；
 * 分页时 LIMIT 作用在 mailboxes 上，没有排序步骤，messageCount 子查询只为返回的行计算。
 */
export async function listMailboxes(env: Env, opts: ListMailboxesOptions): Promise<Mailbox[]>;
export async function listMailboxes(env: Env, opts: ListMailboxesOptions, page: PageRequest | null): Promise<Mailbox[] | Page<Mailbox>>;
export async function listMailboxes(env: Env, opts: ListMailboxesOptions, page: PageRequest | null = null): Promise<Mailbox[] | Page<Mailbox>> {
  const db = createDb(env);
  const where = and(
    opts.all ? undefined : eq(mailboxes.userId, opts.userId!),
    opts.domain ? eq(mailboxes.domain, opts.domain) : undefined,
    opts.q ? mailboxSearchSql(opts.q) : undefined,
    restrictedMailboxes(opts.restrict),
    page?.cursorId ? lt(mailboxes.id, page.cursorId) : undefined,
  );
  let items: Mailbox[];
  if (opts.all) {
    const rows = await db
      .select({ mailbox: mailboxes, username: users.username, messageCount: messageCountSql, ...sendableColumns })
      .from(mailboxes)
      .leftJoin(users, eq(users.id, mailboxes.userId))
      .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
      .where(where)
      .orderBy(desc(mailboxes.id))
      .limit(fetchLimit(page))
      .all();
    items = rows.map((r) => ({ ...serialize(r.mailbox, Number(r.messageCount), r.username ?? ''), canSend: hostedSendBlock(r) === null }));
  } else {
    const rows = await db
      .select({ mailbox: mailboxes, messageCount: messageCountSql, ...sendableColumns })
      .from(mailboxes)
      .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
      .where(where)
      .orderBy(desc(mailboxes.id))
      .limit(fetchLimit(page))
      .all();
    items = rows.map((r) => ({ ...serialize(r.mailbox, Number(r.messageCount)), canSend: hostedSendBlock(r) === null }));
  }
  return page ? toPage(items, page.limit, (box) => box.id) : items;
}

/** 管理员按 id 读任意邮箱：与 ?all=1 列表同形（含所有者用户名、邮件数与 canSend），一次查询 */
export async function getMailbox(env: Env, id: number): Promise<Mailbox> {
  const row = await createDb(env)
    .select({ mailbox: mailboxes, username: users.username, messageCount: messageCountSql, ...sendableColumns })
    .from(mailboxes)
    .leftJoin(users, eq(users.id, mailboxes.userId))
    .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
    .where(eq(mailboxes.id, id))
    .get();
  if (!row) throw new AppError('not_found', '邮箱不存在');
  return { ...serialize(row.mailbox, Number(row.messageCount), row.username ?? ''), canSend: hostedSendBlock(row) === null };
}

interface ClaimPolicy {
  /** 普通用户的全局/按域认领上限（0=不限；管理员恒为 0），供 INSERT 时原子复核 */
  perUserLimit: number;
  perDomainLimit: number;
  /** 托管域名：INSERT 复核托管权限，不复核系统域名列表与专属配置版本 */
  hosted: boolean;
  /** 第一条不满足的规则；null 表示规则层面可认领（地址占用另判） */
  blocked: { reason: MailboxUnavailableReason; error: AppError } | null;
}

/** 用户已认领的地址数：合计与按域名分布 */
interface OwnedCounts {
  total: number;
  byDomain: Map<string, number>;
}

/** 托管域名下的地址不计入全站每人认领上限，只受域名所有者设置的成员上限约束 */
const SYSTEM_OWNED_COUNT_SQL = `(SELECT COUNT(*) FROM mailboxes WHERE user_id = ?
  AND domain NOT IN (SELECT domain FROM hosted_domains))`;

/** 一条 GROUP BY 同时给出按域计数与是否托管域名（走 idx_mailboxes_user）；合计不含托管域名 */
export function ownedCountsStatement(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare(`SELECT domain, COUNT(*) AS n,
    EXISTS (SELECT 1 FROM hosted_domains WHERE hosted_domains.domain = mailboxes.domain) AS hosted
    FROM mailboxes WHERE user_id = ? GROUP BY domain`).bind(userId);
}

export function ownedCountsFromResult(result: D1Result | undefined): OwnedCounts {
  const byDomain = new Map<string, number>();
  let total = 0;
  for (const row of (result?.results ?? []) as { domain: string; n: number; hosted: number }[]) {
    byDomain.set(row.domain, Number(row.n));
    if (!Number(row.hosted)) total += Number(row.n);
  }
  return { total, byDomain };
}

/** 认领人对托管域名的权限：状态、所有者、是否成员与成员上限，与认领上下文一起读取 */
export interface HostedClaimAccess {
  status: HostedDomainStatus;
  ownerId: number;
  isMember: boolean;
  memberLimit: number;
}

function hostedAccessStatement(db: D1Database, userId: number, domains: string[]): D1PreparedStatement {
  return db.prepare(`SELECT h.domain, h.user_id, h.status, h.member_limit,
      EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = h.id AND m.user_id = ?1) AS is_member
    FROM hosted_domains h WHERE h.domain IN (SELECT value FROM json_each(?2))`).bind(userId, JSON.stringify(domains));
}

function hostedAccessFromResult(result: D1Result | undefined): Map<string, HostedClaimAccess> {
  const rows = (result?.results ?? []) as { domain: string; user_id: number; status: HostedDomainStatus; member_limit: number; is_member: number }[];
  return new Map(rows.map((row) => [row.domain, {
    status: row.status, ownerId: Number(row.user_id), isMember: Number(row.is_member) === 1, memberLimit: Number(row.member_limit),
  }]));
}

/**
 * 托管域名的认领守卫（INSERT 内原子复核）：域名已生效，且认领人是所有者、成员或管理员。
 * 绑定顺序：域名、角色、用户 id、用户 id。
 */
const HOSTED_CLAIM_GUARD_SQL = `EXISTS (SELECT 1 FROM hosted_domains h WHERE h.domain = ?
  AND h.status IN (${HOSTED_DOMAIN_USABLE_STATUSES.map((status) => `'${status}'`).join(', ')})
  AND (? = 'admin' OR h.user_id = ? OR EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = h.id AND m.user_id = ?)))`;

const CLAUDE_SUSPENDED_MESSAGE = '该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领';

/**
 * 认领规则唯一来源：认领、批量认领、可用性检查与过户共用，避免几处判定漂移。
 * 顺序：域名存在与授权 → 保留前缀 → 全局上限 → 按域名上限 → Claude 封号（显式选择时）。
 * 管理员同样受 Claude 策略约束；纯函数，所需数据由调用方一次读齐。
 */
export function evaluateClaimPolicy(
  settings: ClaimSettings,
  user: MailboxPolicyUser,
  owned: OwnedCounts,
  localPart: string,
  domain: string,
  hosted?: HostedClaimAccess,
  claudeSuspended = false,
): ClaimPolicy {
  const block = (reason: MailboxUnavailableReason, error: AppError): ClaimPolicy => ({ perUserLimit: 0, perDomainLimit: 0, hosted: !!hosted, blocked: { reason, error } });
  // 所有放行分支（含管理员与托管域所有者）统一检查封号，但不能向无权认领的用户泄露域名事实。
  const allow = (perUserLimit = 0, perDomainLimit = 0): ClaimPolicy => claudeSuspended
    ? block('claude_suspended', new AppError('forbidden', CLAUDE_SUSPENDED_MESSAGE))
    : { perUserLimit, perDomainLimit, hosted: !!hosted, blocked: null };
  if (hosted) {
    // 托管域名：所有者与管理员不受限；成员受保留前缀与成员上限约束；其他人不可见
    if (!(HOSTED_DOMAIN_USABLE_STATUSES as readonly string[]).includes(hosted.status)) {
      return block('domain_unavailable', new AppError('forbidden', '该域名尚未生效或已停用'));
    }
    if (user.role === 'admin' || hosted.ownerId === user.id) return allow();
    if (!hosted.isMember) return block('domain_unavailable', new AppError('forbidden', '当前用户无权认领该域名'));
    if (settings.mailbox_policy.reservedLocalParts.includes(localPart)) {
      return block('reserved', new AppError('forbidden', `前缀 ${localPart} 为系统保留，无法认领`));
    }
    if (hosted.memberLimit > 0 && (owned.byDomain.get(domain) ?? 0) >= hosted.memberLimit) {
      return block('domain_limit', new AppError('forbidden', `在该域名下最多认领 ${hosted.memberLimit} 个地址`));
    }
    return allow(0, hosted.memberLimit);
  }
  if (!settings.domains.list.some((entry) => entry.domain === domain)) {
    return block('domain_unavailable', new AppError('validation_failed', '域名不在系统域名列表内'));
  }
  const policy = resolveMailboxPolicy(settings, user);
  if (user.role === 'admin') return allow();
  const domainPolicy = policy.domains.find((entry) => entry.domain === domain);
  if (!domainPolicy) {
    return block('domain_unavailable', new AppError('forbidden', '当前用户无权认领该域名'));
  }
  // 保留前缀禁止认领（防冒充官方身份）
  if (policy.reservedLocalParts.includes(localPart)) {
    return block('reserved', new AppError('forbidden', `前缀 ${localPart} 为系统保留，无法认领`));
  }
  // 全局每用户认领上限（跨域名合计，防囤积）
  if (policy.perUserLimit > 0 && owned.total >= policy.perUserLimit) {
    return block('quota', new AppError('forbidden', `认领地址数已达上限（${policy.perUserLimit}）`));
  }
  // 按域名上限：统计该用户在此域名下已认领数
  const domainLimit = domainPolicy.perUserLimit;
  if (domainLimit > 0 && (owned.byDomain.get(domain) ?? 0) >= domainLimit) {
    return block('domain_limit', new AppError('forbidden', `在该域名下最多认领 ${domainLimit} 个地址`));
  }
  return allow(policy.perUserLimit, domainLimit);
}

/** 认领与可用性检查的规则输入。批量认领时每成功一个就地累加，后续地址按最新计数判定。 */
interface ClaimContext {
  userId: number;
  settings: ClaimSettings;
  user: MailboxPolicyUser;
  owned: OwnedCounts;
  /** 已被认领的地址：读取时已存在的，加上本批刚认领的 */
  taken: Set<string>;
  /** 本次涉及的托管域名及当前用户的权限 */
  hosted: Map<string, HostedClaimAccess>;
  /** 本次 Claude 策略涉及的域名中，存在任意历史封号事实的域名 */
  claudeSuspended: Set<string>;
}

const addressOf = (req: ClaimMailboxRequest) => `${req.localPart}@${req.domain}`;

/** 与 getSettingsFresh 同一个合并函数（只读回 domains / mailbox_policy 两行，其余项为默认值且不使用） */
export const claimSettingsFrom = (result: D1Result | undefined): ClaimSettings =>
  mergeSettingRows((result?.results ?? []) as { key: string; value: string }[]);

/** 规则所需的全部读取合成一个 D1 batch：认领设置（强一致直读）、用户权限、已认领数、地址占用。 */
async function loadClaimContext(env: Env, actor: { userId: number; role: Role }, items: ClaimMailboxRequest[], loadSuspensions = true): Promise<ClaimContext> {
  const unique = [...new Set(items.map(addressOf))];
  const domains = [...new Set(items.map((item) => item.domain))];
  const claudeDomains = loadSuspensions ? [...new Set(items.filter((item) => item.strategy === 'claude').map((item) => item.domain))] : [];
  const [settingsResult, userResult, ownedResult, takenResult, hostedResult, suspendedResult] = await env.db.batch([
    claimSettingsStatement(env.db),
    mailboxPolicyUserStatement(env.db, actor.userId),
    ownedCountsStatement(env.db, actor.userId),
    env.db.prepare('SELECT address FROM mailboxes WHERE address IN (SELECT value FROM json_each(?))').bind(JSON.stringify(unique)),
    hostedAccessStatement(env.db, actor.userId, domains),
    ...(claudeDomains.length ? [env.db.prepare(`SELECT DISTINCT domain FROM claude_address_facts
      WHERE domain IN (SELECT value FROM json_each(?)) AND suspended > 0`).bind(JSON.stringify(claudeDomains))] : []),
  ]);
  return {
    userId: actor.userId,
    settings: claimSettingsFrom(settingsResult),
    user: mailboxPolicyUserFromResult(userResult),
    owned: ownedCountsFromResult(ownedResult),
    taken: new Set(((takenResult?.results ?? []) as { address: string }[]).map((row) => row.address)),
    hosted: hostedAccessFromResult(hostedResult),
    claudeSuspended: new Set(((suspendedResult?.results ?? []) as { domain: string }[]).map((row) => row.domain)),
  };
}

/** 原生 SQL 读回的邮箱行（RETURNING 或 SELECT），带历史邮件数 */
interface MailboxSqlRow {
  id: number;
  address: string;
  domain: string;
  user_id: number;
  display_name: string;
  created_at: number;
  message_count: number;
}

const MAILBOX_SQL_COLUMNS = `id, address, domain, user_id, display_name, created_at,
  (SELECT COUNT(*) FROM messages WHERE messages.address = mailboxes.address) AS message_count`;

function fromSqlRow(row: MailboxSqlRow): Mailbox {
  return serialize({
    id: Number(row.id),
    address: row.address,
    domain: row.domain,
    userId: Number(row.user_id),
    displayName: row.display_name,
    createdAt: new Date(Number(row.created_at)),
  }, Number(row.message_count));
}

/** 规则判定 → 占用判定 → 带守卫的 INSERT（RETURNING 直接带回整行与历史邮件数）。成功后更新 context。 */
async function claimWithContext(env: Env, context: ClaimContext, req: ClaimMailboxRequest): Promise<Mailbox> {
  const { settings, user: policyUser, userId } = context;
  const policy = evaluateClaimPolicy(settings, policyUser, context.owned, req.localPart, req.domain, context.hosted.get(req.domain),
    req.strategy === 'claude' && context.claudeSuspended.has(req.domain));
  if (policy.blocked) throw policy.blocked.error;
  const { perUserLimit, perDomainLimit } = policy;

  const address = addressOf(req);
  if (context.taken.has(address)) throw new AppError('address_taken', '该地址已被占用');
  const returning = `RETURNING ${MAILBOX_SQL_COLUMNS}`;
  try {
    // Domain revision and quotas are checked in the same write as INSERT. A
    // concurrent domain removal/private toggle must not create a stale claim.
    // 托管域名改为复核域名状态与认领人权限，不计入全站每人上限。
    const inserted = policy.hosted
      ? await env.db
        .prepare(
          `INSERT INTO mailboxes (address, domain, user_id, display_name)
           SELECT ?, ?, ?, ''
           WHERE (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = ?)
             AND ${HOSTED_CLAIM_GUARD_SQL}
             AND (? = 0 OR NOT EXISTS (SELECT 1 FROM claude_address_facts WHERE domain = ? AND suspended > 0))
           ${returning}`,
        )
        .bind(address, req.domain, userId, perDomainLimit, userId, req.domain, perDomainLimit,
          userId, policyUser.role, req.domain, policyUser.role, userId, userId, req.strategy === 'claude' ? 1 : 0, req.domain)
        .first<MailboxSqlRow>()
      : await env.db
        .prepare(
          `INSERT INTO mailboxes (address, domain, user_id, display_name)
           SELECT ?, ?, ?, ''
           WHERE (? = 0 OR ${SYSTEM_OWNED_COUNT_SQL} < ?)
             AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
             AND COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ?
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = ? AND mailbox_policy_revision = ?)
             AND EXISTS (SELECT 1 FROM settings, json_each(settings.value, '$.list') AS configured
               WHERE settings.key = 'domains'
                 AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
                   ELSE json_extract(configured.value, '$.domain') END)) = ?)
             AND (? = 0 OR NOT EXISTS (SELECT 1 FROM claude_address_facts WHERE domain = ? AND suspended > 0))
           ${returning}`,
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
          userId,
          policyUser.role,
          policyUser.mailboxPolicyRevision,
          req.domain,
          req.strategy === 'claude' ? 1 : 0,
          req.domain,
        )
        .first<MailboxSqlRow>();
    if (!inserted) throw await claimGuardError(env, context, req, policy.hosted);
    context.taken.add(address);
    if (!policy.hosted) context.owned.total += 1;
    context.owned.byDomain.set(req.domain, (context.owned.byDomain.get(req.domain) ?? 0) + 1);
    return fromSqlRow(inserted);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: mailboxes.address')) {
      throw new AppError('address_taken', '该地址已被占用');
    }
    throw error;
  }
}

/** INSERT 守卫未通过：合批读回域名、用户与封号事实，先复核当前授权再报告封号。 */
async function claimGuardError(env: Env, context: ClaimContext, req: ClaimMailboxRequest, hosted = false): Promise<AppError> {
  const hostedConflict = () => new AppError('conflict', '域名状态、权限或成员上限已改变，请刷新后重试');
  if (hosted && req.strategy !== 'claude') return hostedConflict();
  const [settingsResult, userResult, suspendedResult, hostedResult] = await env.db.batch([
    claimSettingsStatement(env.db),
    mailboxPolicyUserStatement(env.db, context.userId),
    ...(req.strategy === 'claude' ? [env.db.prepare('SELECT 1 FROM claude_address_facts WHERE domain = ? AND suspended > 0 LIMIT 1').bind(req.domain)] : []),
    ...(hosted ? [hostedAccessStatement(env.db, context.userId, [req.domain])] : []),
  ]);
  const current = claimSettingsFrom(settingsResult);
  if (!hosted && (current.domains.revision ?? 0) !== (context.settings.domains.revision ?? 0)) {
    return new AppError('conflict', '域名配置已改变，请刷新后重试');
  }
  const currentUser = mailboxPolicyUserFromResult(userResult);
  if ((!hosted && currentUser.mailboxPolicyRevision !== context.user.mailboxPolicyRevision) || currentUser.role !== context.user.role) {
    return new AppError('conflict', '邮箱权限已改变，请刷新后重试');
  }
  if (hosted) {
    const access = hostedAccessFromResult(hostedResult).get(req.domain);
    if (!access || evaluateClaimPolicy(current, currentUser, { total: 0, byDomain: new Map() }, req.localPart, req.domain, access).blocked) {
      return hostedConflict();
    }
  }
  if (suspendedResult?.results.length) return new AppError('forbidden', CLAUDE_SUSPENDED_MESSAGE);
  if (hosted) return hostedConflict();
  return new AppError('forbidden', '认领配额已在并发请求中用尽，请刷新后重试');
}

/** 认领地址：domain 必须 ∈ 系统域名，address 全局唯一，普通用户受保留前缀/配额限制 */
export async function claimMailbox(
  env: Env,
  userId: number,
  role: Role,
  req: ClaimMailboxRequest,
): Promise<Mailbox> {
  const context = await loadClaimContext(env, { userId, role }, [req]);
  // await：规则不通过时 claimWithContext 在首个 await 前就已 reject，直接 return 会被 workerd 记为未处理
  return await claimWithContext(env, context, req);
}

/** 每块两条 SQL、一次事务；999 个地址也不超过 D1 Free 的每调用查询数限制。 */
const CLAIM_CHUNK_SIZE = 100;

/**
 * 先标记已有/重复地址，再按输入顺序累计新地址，找出第一条不满足规则的记录。
 * SELECT 计划和 INSERT 使用相同 CTE，放在同一 D1 batch 事务中，其他写入不能插到两者之间。
 */
const BATCH_CLAIM_PLAN_SQL = `WITH
  live_owned AS MATERIALIZED (
    SELECT domain, COUNT(*) AS n FROM mailboxes WHERE user_id = ?2 GROUP BY domain
  ),
  live_total AS MATERIALIZED (
    SELECT COALESCE(SUM(n), 0) AS n FROM live_owned WHERE domain NOT IN (SELECT domain FROM hosted_domains)
  ),
  input AS (
    SELECT CAST(key AS INTEGER) AS position,
      json_extract(value, '$.address') AS address,
      json_extract(value, '$.domain') AS domain,
      json_extract(value, '$.perUserLimit') AS user_limit,
      json_extract(value, '$.perDomainLimit') AS domain_limit,
      json_extract(value, '$.ownedDomain') AS owned_domain,
      json_extract(value, '$.wasTaken') AS was_taken,
      json_extract(value, '$.hosted') AS hosted,
      json_extract(value, '$.strategy') AS strategy,
      json_extract(value, '$.code') AS policy_code,
      json_extract(value, '$.message') AS policy_message
    FROM json_each(?1)
  ),
  claude_domains AS MATERIALIZED (
    SELECT DISTINCT domain FROM input WHERE strategy = 'claude'
  ),
  blocked_domains AS MATERIALIZED (
    SELECT domain FROM claude_domains WHERE EXISTS (
      SELECT 1 FROM claude_address_facts f WHERE f.domain = claude_domains.domain AND f.suspended > 0
    )
  ),
  numbered AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY address ORDER BY position) AS occurrence,
      EXISTS (SELECT 1 FROM mailboxes WHERE mailboxes.address = input.address) AS existing
    FROM input
  ),
  counted AS (
    SELECT *, (was_taken = 0 AND existing = 0 AND occurrence = 1) AS is_new,
      COALESCE(SUM(was_taken = 0 AND existing = 0 AND occurrence = 1 AND hosted = 0) OVER (
        ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS added,
      COALESCE(SUM(was_taken = 0 AND existing = 0 AND occurrence = 1) OVER (
        PARTITION BY domain ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS domain_added
    FROM numbered
  ),
  checked AS (
    SELECT *, CASE
      WHEN policy_code IS NOT NULL THEN policy_code
      WHEN user_limit > 0 AND ?3 + added >= user_limit THEN 'quota'
      WHEN domain_limit > 0 AND owned_domain + domain_added >= domain_limit THEN 'domain_limit'
      WHEN (strategy = 'claude' OR (was_taken = 0 AND (existing OR occurrence = 1))) AND (
        (user_limit > 0 AND (SELECT n FROM live_total) + added >= user_limit)
        OR (domain_limit > 0 AND COALESCE((SELECT n FROM live_owned WHERE domain = counted.domain), 0) + domain_added >= domain_limit)
        OR (hosted = 0 AND COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) != ?4)
        OR NOT EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active' AND role = ?5
          AND (counted.hosted = 1 OR mailbox_policy_revision = ?6))
        OR (hosted = 0 AND NOT EXISTS (SELECT 1 FROM settings, json_each(settings.value, '$.list') AS configured
          WHERE settings.key = 'domains' AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
            ELSE json_extract(configured.value, '$.domain') END)) = counted.domain))
        OR (hosted = 1 AND NOT EXISTS (SELECT 1 FROM hosted_domains h WHERE h.domain = counted.domain
          AND h.status IN (${HOSTED_DOMAIN_USABLE_STATUSES.map((status) => `'${status}'`).join(', ')})
          AND (?5 = 'admin' OR h.user_id = ?2
            OR EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = h.id AND m.user_id = ?2))))
      ) THEN 'guard'
      WHEN strategy = 'claude' AND domain IN (SELECT domain FROM blocked_domains) THEN 'claude_suspended'
      ELSE NULL END AS blocked
    FROM counted
  ),
  planned AS (
    SELECT * FROM checked WHERE position <= COALESCE((SELECT MIN(position) FROM checked WHERE blocked IS NOT NULL), 2147483647)
  )`;

interface PlannedClaimRow {
  position: number;
  address: string;
  is_new: number;
  blocked: string | null;
  policy_message: string | null;
  user_limit: number;
  domain_limit: number;
}

async function claimChunk(env: Env, context: ClaimContext, items: ClaimMailboxRequest[]) {
  const inputs = items.map((item) => {
    // 配额在事务内按实际成功的前缀累计；这里仅冻结域名、权限和保留前缀规则。
    const policy = evaluateClaimPolicy(context.settings, context.user, { total: 0, byDomain: new Map() }, item.localPart, item.domain,
      context.hosted.get(item.domain));
    return {
      address: addressOf(item), domain: item.domain, hosted: policy.hosted ? 1 : 0, strategy: item.strategy ?? 'uniform',
      perUserLimit: policy.perUserLimit, perDomainLimit: policy.perDomainLimit,
      ownedDomain: context.owned.byDomain.get(item.domain) ?? 0,
      wasTaken: context.taken.has(addressOf(item)) ? 1 : 0,
      code: policy.blocked?.error.code ?? null, message: policy.blocked?.error.message ?? null,
    };
  });
  const bindings = [JSON.stringify(inputs), context.userId, context.owned.total, context.settings.domains.revision ?? 0,
    context.user.role, context.user.mailboxPolicyRevision];
  const [plan, inserted] = await env.db.batch([
    env.db.prepare(`${BATCH_CLAIM_PLAN_SQL} SELECT position, address, is_new, blocked, policy_message, user_limit, domain_limit FROM planned ORDER BY position`).bind(...bindings),
    env.db.prepare(`${BATCH_CLAIM_PLAN_SQL}
      INSERT INTO mailboxes (address, domain, user_id, display_name)
      SELECT address, domain, ?2, '' FROM planned WHERE blocked IS NULL AND is_new ORDER BY position
      RETURNING ${MAILBOX_SQL_COLUMNS}`).bind(...bindings),
  ]);
  return {
    plan: plan!.results as unknown as PlannedClaimRow[],
    inserted: new Map((inserted!.results as unknown as MailboxSqlRow[]).map((row) => [row.address, row])),
  };
}

/** 按顺序分块认领：占用跳过；首个业务错误停止，之前完成的块和本块前缀保留。 */
export async function claimMailboxes(
  env: Env,
  userId: number,
  role: Role,
  items: ClaimMailboxRequest[],
): Promise<BatchClaimMailboxResult> {
  const result: BatchClaimMailboxResult = { claimed: [], taken: [], notAttempted: [], stoppedBy: null };
  let index = 0;
  let started = false;
  try {
    // 批量在每块事务内读取最新封号事实，无需在上下文中预读不会使用的快照。
    const context = await loadClaimContext(env, { userId, role }, items, false);
    started = true;
    while (index < items.length) {
      const chunk = items.slice(index, index + CLAIM_CHUNK_SIZE);
      const { plan, inserted } = await claimChunk(env, context, chunk);
      for (const row of plan) {
        const item = items[index]!;
        if (row.blocked) {
          if (row.blocked === 'claude_suspended') throw new AppError('forbidden', CLAUDE_SUSPENDED_MESSAGE);
          if (row.blocked === 'guard') throw await claimGuardError(env, context, item, context.hosted.has(item.domain));
          if (row.blocked === 'quota') throw new AppError('forbidden', `认领地址数已达上限（${row.user_limit}）`);
          if (row.blocked === 'domain_limit') throw new AppError('forbidden', `在该域名下最多认领 ${row.domain_limit} 个地址`);
          throw new AppError(row.blocked as AppError['code'], row.policy_message!);
        }
        if (!row.is_new) {
          result.taken.push(item);
        } else {
          const mailbox = inserted.get(row.address);
          if (!mailbox) throw new Error('批量认领写入结果缺失');
          result.claimed.push(fromSqlRow(mailbox));
          context.taken.add(row.address);
          if (!context.hosted.has(item.domain)) context.owned.total++;
          context.owned.byDomain.set(item.domain, (context.owned.byDomain.get(item.domain) ?? 0) + 1);
        }
        index++;
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      result.stoppedBy = { code: error.code, message: error.message };
    } else if (started) {
      // 已有地址提交后不能变成 500：调用方需要知道哪些已认领。出错那项结果不确定，与其后各项一起列入 notAttempted。
      console.error('批量认领中断:', error);
      result.stoppedBy = { code: 'internal', message: '认领中断，部分地址可能已认领，请以邮箱列表为准' };
    } else {
      throw error;
    }
    result.notAttempted = items.slice(index);
  }
  return result;
}

function availabilityOf(context: ClaimContext, req: ClaimMailboxRequest): MailboxAvailability {
  const address = addressOf(req);
  const policy = evaluateClaimPolicy(context.settings, context.user, context.owned, req.localPart, req.domain, context.hosted.get(req.domain),
    req.strategy === 'claude' && context.claudeSuspended.has(req.domain));
  if (policy.blocked) return { address, available: false, reason: policy.blocked.reason };
  return context.taken.has(address) ? { address, available: false, reason: 'taken' } : { address, available: true };
}

/** 邮箱行与所有者用户名（审计写所有者用），一次查询 */
async function mailboxWithOwner(env: Env, id: number) {
  const row = await createDb(env).select({ mailbox: mailboxes, ownerName: users.username })
    .from(mailboxes).leftJoin(users, eq(users.id, mailboxes.userId)).where(eq(mailboxes.id, id)).get();
  return row && { ...row.mailbox, ownerName: row.ownerName };
}

export const ownerLabel = (row: { userId: number; ownerName: string | null }) =>
  `${row.ownerName ?? `user#${row.userId}`} (#${row.userId})`;

/** actor 为审计操作者：管理员改他人邮箱的发件名时记录前后值，自己的邮箱不记 */
export async function updateMailbox(
  env: Env,
  userId: number,
  id: number,
  displayName: string,
  isAdmin: boolean,
  actor?: AuditActor,
): Promise<Mailbox> {
  const db = createDb(env);
  const row = await mailboxWithOwner(env, id);
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  const result = await db.update(mailboxes).set({ displayName })
    .where(and(eq(mailboxes.id, id), eq(mailboxes.userId, row.userId))).run();
  if (!result.meta.changes) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
  // 审计与读回合进同一个 batch，不多一次往返
  const audited = isAdmin && actor !== undefined && row.userId !== userId && row.displayName !== displayName;
  const results = await env.db.batch([
    ...(audited ? [auditStatement(env, actor, 'mailbox.update', row.address,
      `发件名「${row.displayName}」→「${displayName}」；所有者 ${ownerLabel(row)}`)] : []),
    env.db.prepare(`SELECT ${MAILBOX_SQL_COLUMNS} FROM mailboxes WHERE id = ?`).bind(id),
  ]);
  const updated = results[results.length - 1]?.results?.[0] as MailboxSqlRow | undefined;
  if (!updated) throw new AppError('not_found', '邮箱已被释放，请刷新后重试');
  return fromSqlRow(updated);
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
  // 公共配置用户保留管理员强制过户行为；专属用户的新增归属遵守其完整认领规则。托管域名的地址由管理员强制过户。
  const hosted = await db.select({ id: hostedDomains.id }).from(hostedDomains).where(eq(hostedDomains.domain, row.domain)).get();
  const settings = !hosted && target.role === 'user' && target.mailboxPolicy !== null ? await getSettingsFresh(env) : undefined;
  const policy = settings ? evaluateClaimPolicy(settings, target, ownedCountsFromResult(await ownedCountsStatement(env.db, target.id).all()),
    row.address.slice(0, row.address.lastIndexOf('@')), row.domain) : undefined;
  if (policy?.blocked) throw policy.blocked.error;
  const totalLimit = policy?.perUserLimit ?? 0;
  const domainLimit = policy?.perDomainLimit ?? 0;
  const previous = await db.select({ username: users.username }).from(users).where(eq(users.id, row.userId)).get();
  const detail = `${previous?.username ?? `user#${row.userId}`} (#${row.userId}) → ${target.username} (#${target.id})；保留全部历史并撤销旧共享`;
  const results = await env.db.batch([
    env.db.prepare(`UPDATE mailboxes SET user_id = ? WHERE id = ? AND user_id = ? AND user_id <> ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND role = ? AND mailbox_policy_revision = ?)
      AND (? = 0 OR ${SYSTEM_OWNED_COUNT_SQL} < ?)
      AND (? = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ? AND domain = ?) < ?)
      AND (? = 0 OR COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ?)`)
      .bind(target.id, id, req.expectedOwnerId, target.id, target.id, target.role, target.mailboxPolicyRevision,
        totalLimit, target.id, totalLimit, domainLimit, target.id, row.domain, domainLimit,
        settings ? 1 : 0, settings?.domains.revision ?? 0),
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
    throw new AppError('conflict', '邮箱归属、目标用户权限或额度已改变，请刷新后重新确认');
  }
  // 返回本次提交的结果；若另一管理员随后再次过户，客户端读回列表即可发现。
  return resultFor({ ...row, userId: target.id }, true, results[2]?.meta.changes ?? 0);
}

/**
 * 批量写入的前置闸门：violation 查出任一行（某项的前置条件已不成立）就插入 actor_id 为 NULL 的行，
 * 触发 NOT NULL 约束使整个 batch 事务回滚。闸门之后的语句不必重复这些条件：同一事务里没有别的写入能插进来。
 */
export function batchGateStatement(env: Env, violation: string, ...params: unknown[]): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, action) SELECT NULL, 'batch.gate' WHERE EXISTS (${violation})`)
    .bind(...params);
}

export function isBatchGateError(error: unknown): boolean {
  return String(error).includes('NOT NULL constraint failed: admin_audit_logs.actor_id');
}

/** 待释放的邮箱：读取时的所有者及其用户名（审计用） */
export interface ReleaseTarget {
  id: number;
  address: string;
  userId: number;
  ownerName: string | null;
}

export interface ReleaseOutcome {
  deletedMessages: number;
  revokedShares: number;
}

/** 释放审计：操作者与 detail 末尾的附加说明（如批量标记） */
export interface ReleaseAudit {
  actor: AuditActor;
  note: string;
}

/**
 * 释放一组邮箱，全部写入同一个 D1 事务：闸门（每只邮箱仍归读取时的所有者，否则整批回滚）→
 * [按地址圈定历史邮件并逐地址计数] → 审计（mailbox.release，删除条数在事务内计出）→ [删除邮件] → 撤销共享 → 删除邮箱。
 * 历史邮件在事务内按地址圈定，授权之后、提交之前刚到的来信也一并删除。
 */
export async function releaseTargets(
  env: Env,
  targets: readonly ReleaseTarget[],
  deleteHistory: boolean,
  audit: ReleaseAudit | null,
  ctx?: ExecCtx | null,
): Promise<Map<number, ReleaseOutcome>> {
  // 每项的 id/所有者/地址作为一个 JSON 参数传入：绑定参数个数不随项数增长
  const items = JSON.stringify(targets.map((target) => ({
    id: target.id, userId: target.userId, address: target.address, detail: `原所有者 ${ownerLabel(target)}`,
  })));
  const ids = `SELECT json_extract(value, '$.id') FROM json_each(?1)`;
  const token = deleteHistory ? crypto.randomUUID() : null;
  const statements = [batchGateStatement(env, `SELECT 1 FROM json_each(?1) j WHERE NOT EXISTS (SELECT 1 FROM mailboxes
    WHERE id = json_extract(j.value, '$.id') AND user_id = json_extract(j.value, '$.userId'))`, items)];
  if (token) {
    statements.push(
      env.db.prepare(`UPDATE messages SET purge_token = ?2 WHERE address IN (SELECT json_extract(value, '$.address') FROM json_each(?1))`)
        .bind(items, token),
      env.db.prepare('SELECT address, COUNT(*) AS n FROM messages WHERE purge_token = ? GROUP BY address').bind(token),
    );
  }
  if (audit) {
    statements.push(env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?1, ${ACTOR_NAME_SQL}, 'mailbox.release', json_extract(j.value, '$.address'),
        json_extract(j.value, '$.detail') || CASE WHEN ?2 IS NULL THEN '；保留历史邮件'
          ELSE '；永久删除历史邮件 ' || (SELECT COUNT(*) FROM messages WHERE purge_token = ?2
            AND address = json_extract(j.value, '$.address')) || ' 封' END || ?3, ?4
      FROM json_each(?5) j`).bind(audit.actor.id, token, `${audit.note}${auditSuffix(audit.actor)}`, audit.actor.ip, items));
  }
  if (token) statements.push(...purgeStatements(env, token));
  const sharesIndex = statements.length;
  statements.push(
    env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id IN (${ids}) RETURNING mailbox_id`).bind(items),
    env.db.prepare(`DELETE FROM mailboxes WHERE id IN (${ids})`).bind(items),
  );
  let results: D1Result[];
  try {
    results = await env.db.batch(statements);
  } catch (error) {
    if (isBatchGateError(error)) throw new AppError('conflict', '邮箱归属已改变，请刷新后重试');
    throw error;
  }
  const deleted = new Map(((token ? results[2]?.results : undefined) as { address: string; n: number }[] | undefined ?? [])
    .map((row) => [row.address, Number(row.n)]));
  const revoked = countByMailbox(results[sharesIndex]?.results);
  if (token) await scheduleStorageCleanup(env, ctx, 100);
  return new Map(targets.map((target) => [target.id, {
    deletedMessages: deleted.get(target.address) ?? 0, revokedShares: revoked.get(target.id) ?? 0,
  }]));
}

/** 按 mailbox_id 计数 RETURNING mailbox_id 的结果行（撤销、新增了几条共享） */
export function countByMailbox(rows: readonly unknown[] | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of (rows ?? []) as { mailbox_id: number }[]) counts.set(Number(row.mailbox_id), (counts.get(Number(row.mailbox_id)) ?? 0) + 1);
  return counts;
}

/**
 * 释放地址。默认历史邮件不动（随地址回到未认领态，下一个认领者可见）；
 * deleteHistory=true 时同时删除该地址名下全部邮件——堵住「释放后被他人继承验证码/账单」的隐私路径。
 * 元数据与清理台账同一事务提交；传入 ctx 时 R2 删除放进 waitUntil，不阻塞响应。
 * actor 为审计操作者：管理员释放他人邮箱时，mailbox.release 审计与释放同一事务。
 */
export async function releaseMailbox(
  env: Env,
  userId: number,
  id: number,
  isAdmin: boolean,
  deleteHistory = false,
  ctx?: ExecCtx | null,
  actor?: AuditActor,
): Promise<{ deletedMessages: number }> {
  const row = await mailboxWithOwner(env, id);
  if (!row || (!isAdmin && row.userId !== userId)) throw new AppError('not_found', '邮箱不存在');
  const audit = isAdmin && actor !== undefined && row.userId !== userId ? { actor, note: '' } : null;
  const outcome = await releaseTargets(env, [row], deleteHistory, audit, ctx);
  return { deletedMessages: outcome.get(id)?.deletedMessages ?? 0 };
}

/** 可用性提示：与认领同一套规则（evaluateClaimPolicy），不可用时给出 reason；不预订地址 */
export async function checkAvailability(
  env: Env,
  actor: { userId: number; role: Role },
  localPart: string,
  domain: string,
  strategy?: ClaimPlanStrategy,
): Promise<MailboxAvailability> {
  const req = { localPart, domain, strategy };
  return availabilityOf(await loadClaimContext(env, actor, [req]), req);
}

/** 批量可用性提示：全部读取合成一个 D1 batch，逐项结果与单个检查相同，保持请求顺序 */
export async function checkAvailabilityBatch(
  env: Env,
  actor: { userId: number; role: Role },
  items: ClaimMailboxRequest[],
): Promise<MailboxAvailability[]> {
  const context = await loadClaimContext(env, actor, items);
  return items.map((item) => availabilityOf(context, item));
}

/** 通知归属 SQL（?1 = 收件地址）：收件链路把它并进自己的 batch，必须与 resolveNotifyOwnerIds 同源 */
export const NOTIFY_OWNER_IDS_SQL = `SELECT user_id AS id FROM mailboxes WHERE address = ?1
    UNION ALL
    SELECT id FROM users WHERE role = 'admin' AND status = 'active'
      AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1)`;

/**
 * 通知归属：已认领 → 主人；未认领 → 全部启用中的管理员。收信当时结算，一次查询完成。
 * 托管域名的未认领地址在结算前已由 HOSTED_AUTO_CLAIM_SQL 认领给域名所有者，不会落到管理员。
 */
export async function resolveNotifyOwnerIds(env: Env, address: string): Promise<number[]> {
  const rows = await env.db.prepare(NOTIFY_OWNER_IDS_SQL).bind(address).all<{ id: number }>();
  return rows.results.map((row) => Number(row.id));
}

const USABLE_HOSTED_SQL = HOSTED_DOMAIN_USABLE_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * 托管域名收件（?1 = 收件地址，?2 = 域名）：未认领的地址先认领给域名所有者，邮件随即出现在他的收件箱。
 * 只在域名已生效时认领。hosted_domains.autoClaimLimit 默认 0 不限；管理员设了正数时，域内地址达到该数后不再认领。
 * 须排在 HOSTED_STATUS_SQL 与归属结算之前执行。
 */
export const HOSTED_AUTO_CLAIM_SQL = `INSERT OR IGNORE INTO mailboxes (address, domain, user_id, display_name)
  SELECT ?1, ?2, user_id, '' FROM hosted_domains WHERE domain = ?2 AND status IN (${USABLE_HOSTED_SQL})
    AND (SELECT lim = 0 OR (SELECT COUNT(*) FROM mailboxes WHERE domain = ?2) < lim
      FROM (SELECT COALESCE((SELECT json_extract(value, '$.autoClaimLimit') FROM settings WHERE key = 'hosted_domains'), 0) AS lim))`;

/**
 * 托管域名所有者发信（?1 = 发件地址，?2 = 域名，?3 = 发信人）：域名可用且发信已就绪时，未认领的地址
 * 在发出前认领给所有者，发件记录与之后的回信都在他名下可见。与所有者手动认领同一口径：不占全站每人上限，
 * 也不受只约束收件自动认领的 autoClaimLimit；地址已有主人时不改动，由调用方按主人判定。
 */
export const HOSTED_SEND_CLAIM_SQL = `INSERT OR IGNORE INTO mailboxes (address, domain, user_id, display_name)
  SELECT ?1, ?2, user_id, '' FROM hosted_domains WHERE domain = ?2 AND user_id = ?3
    AND status IN (${USABLE_HOSTED_SQL}) AND sending_status = 'ready'`;

/** 收件域名的托管状态与该地址是否已有主人（?1 = 收件地址，?2 = 域名）；非托管域名无结果 */
export const HOSTED_STATUS_SQL = `SELECT status, EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1) AS claimed
  FROM hosted_domains WHERE domain = ?2`;

/** 托管域名的拒收原因：未生效、已停用，或地址数已达上限而新地址没能认领；其余返回 null */
export function hostedRejectReason(result: D1Result | undefined): string | null {
  const row = result?.results?.[0] as { status?: HostedDomainStatus; claimed?: number } | undefined;
  if (!row?.status) return null;
  if (!(HOSTED_DOMAIN_USABLE_STATUSES as readonly string[]).includes(row.status)) {
    return row.status === 'pending' ? '收件域名尚未生效' : '收件域名已停用';
  }
  return Number(row.claimed) ? null : '收件域名的地址数已达上限';
}

/** 站内投递的收件归属：托管域名停用则拒收；未认领地址先归域名所有者，再结算通知归属，一次往返 */
export async function resolveDeliveryOwners(env: Env, address: string): Promise<{ rejected: string | null; ownerIds: number[] }> {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const [, status, owners] = await env.db.batch([
    env.db.prepare(HOSTED_AUTO_CLAIM_SQL).bind(address, domain),
    env.db.prepare(HOSTED_STATUS_SQL).bind(address, domain),
    env.db.prepare(NOTIFY_OWNER_IDS_SQL).bind(address),
  ]);
  const rejected = hostedRejectReason(status);
  return { rejected, ownerIds: rejected ? [] : (owners?.results ?? []).map((row) => Number((row as { id: number }).id)) };
}

