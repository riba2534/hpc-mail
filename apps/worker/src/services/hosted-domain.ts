import {
  HOSTED_DOMAIN_USABLE_STATUSES,
  type AdminHostedDomainsQuery, type HostedDomain, type HostedDomainMember, type HostedDomainRole, type HostedDomainSteps,
  type HostedDomainStepState, type HostedDomainTransferResult, type HostedDomainsHealth, type Page, type Settings, type TransferHostedDomainRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, inArray, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { hostedDomainMembers, hostedDomains, messages, users } from '../db/schema.js';
import { runDetached } from '../lib/background.js';
import { runLimited } from '../lib/concurrency.js';
import { chunk, d1Statement } from '../lib/d1.js';
import { AppError, errorText } from '../lib/errors.js';
import { fetchLimit, toPage, type PageRequest } from '../lib/pagination.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import { logAdminAction } from './audit.js';
import { subscribeHostedDomainEvents } from './event-subscriptions.js';
import {
  assertZonesVisible, CloudflareApiError, catchAllTargetsWorker, cloudflareCredentials, countZones, createSendingSubdomain, createZone, deleteSendingSubdomain,
  deleteZone, enableRouting, findZone, getCatchAll, getRouting, getSendingDnsStatus, getZone, isCloudflareNotFound,
  isTransientCloudflareError, listSendingSubdomains, putCatchAll, repairSendingDns, requestActivationCheck, verifyToken,
  zoneCreatedSince, zoneCreateRejection, type CfZone, type CloudflareCredentials, type ZoneDeleteGuard,
} from './cloudflare.js';
import { hasDnssec } from './domain-check.js';
import { getSystemFromAddress } from './domain.js';
import { delegationBlock, tombstoneStatement } from './hosted-tombstone.js';
import { onboardingActiveSql, PENDING_ZONES_TOTAL_SQL, systemDomainListedSql } from './domain-occupancy.js';
import { sendFeishuNotification } from './feishu.js';
import { purgeMatchingMessages } from './message-lifecycle.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { sendPushDeerNotification } from './pushdeer.js';
import {
  andGuards, counterReadStatement, counterResult, counterStatement, counterWithinGuard, minuteWindow, type CounterGuard,
} from './rate-counter.js';
import { getSettings, getSettingsFresh } from './setting.js';
import { emitHostedDomainTransitions } from './webhooks.js';

type HostedRow = typeof hostedDomains.$inferSelect;
type Viewer = Pick<AuthUser, 'id' | 'username' | 'role'>;
type Access = HostedDomainRole | null;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** NS 生效后这段时间内未全部就绪仍算 provisioning，之后转为 error 并降低重试频率 */
const PROVISION_GRACE_MS = 30 * MINUTE;
/** 「立即检测」的最短间隔，避免连点刷 Cloudflare API */
const CHECK_THROTTLE_MS = 15_000;
/** 占位后迟迟没有 zone_id：超过该时长视为创建请求中断，由定时任务收尾 */
const RESERVATION_STALE_MS = 10 * MINUTE;
/** 删除时单次定时任务清理邮件的时长上限，剩余的下次继续 */
const TEARDOWN_PURGE_MS = 8_000;
/** 核对租约：覆盖单个域名最坏的核对时长（Cloudflare 单次 10 秒超时 × 串行调用数），超时未释放的可被重新领取 */
const SYNC_LEASE_MS = 3 * MINUTE;
/** 定时巡检单轮的时间预算与并发数；到期没处理的留给下一轮，按 checked_at 最旧优先 */
const SYNC_BUDGET_MS = 20_000;
const SYNC_CONCURRENCY = 4;
/** 曾生效的域名首次查不到 zone 后，至少间隔这么久再次确认仍查不到，才判为已迁走 */
const MISSING_CONFIRM_MS = 25 * MINUTE;

const SYSTEM_ACTOR = { id: 0, username: 'system' };

/**
 * 全站每分钟由用户操作发出的 Cloudflare 调用数：DNS 解析、添加域名与立即检测共用这份额度（scope 名沿用最早只计解析时的）。
 * 所有托管域名共用站长的 Token（全局 1200 次/5 分钟），这里限 150 次/分钟（5 分钟 750 次），给定时开通、巡检和控制台留出余量；
 * 只有能走到 Cloudflare 的请求才计入，按实际调用次数加权。
 */
export const HOSTED_DNS_SITE_RATE_SCOPE = 'hosted_dns_site';
export const MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE = 150;
/** 每位用户每分钟的添加与立即检测次数（管理员也计）；添加只计走到占位这一步的请求，检测计全部请求 */
export const HOSTED_CREATE_RATE_SCOPE = 'hosted_create';
export const HOSTED_CHECK_RATE_SCOPE = 'hosted_check';
export const MAX_HOSTED_CREATES_PER_MINUTE = 5;
export const MAX_HOSTED_CHECKS_PER_MINUTE = 10;
/**
 * 计入全站额度的 Cloudflare 调用数（按调用序列基准用例核实）：添加先按名称查 zone 再创建 2 次，建好后后台预配置
 * catch-all 与发信 5 次；删除撤发信接入、核对并删 zone 3 次；检测在等待 NS 时 2 次，生效后补齐配置约 4 次。
 */
export const CREATE_CF_CALLS = 2;
const PRECONFIGURE_CF_CALLS = 5;
const TEARDOWN_CF_CALLS = 3;
export const CHECK_CF_CALLS = 4;
/** 重新接入：zone 仍在时读 zone、请求复查后再核对一次约 6 次；zone 已删除时确认失踪（含自检）、按名称查找并重建共 5 次 */
export const RECONNECT_CF_CALLS = 6;
const SITE_BUSY = '当前域名操作较多，请稍后再试';

/** 功能可用：设置总开关打开且 Worker 配置了 Cloudflare 凭据 */
export function hostedDomainsAvailable(env: Env, settings: Pick<Settings, 'hosted_domains'>): boolean {
  return settings.hosted_domains.enabled && cloudflareCredentials(env) !== null;
}

function requireCredentials(env: Env, settings: Pick<Settings, 'hosted_domains'>): CloudflareCredentials {
  const creds = cloudflareCredentials(env);
  if (!settings.hosted_domains.enabled || !creds) throw new AppError('forbidden', '本站未开启域名托管');
  return creds;
}

/** 删除 zone 前核对身份：不能是系统域名，创建时间不早于本站记录 */
async function zoneGuard(env: Env, row: HostedRow): Promise<ZoneDeleteGuard> {
  const settings = await getSettings(env);
  return { notBefore: row.createdAt, protectedNames: settings.domains.list.map((entry) => entry.domain) };
}

/** 用户操作触发的后台调用（预配置、删除）只计入全站额度，不因额度拒绝；计数失败不影响任务本身 */
async function recordSiteCalls(env: Env, calls: number): Promise<void> {
  if (!cloudflareCredentials(env)) return;
  await counterStatement(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1), calls).run()
    .catch((error) => console.error('记录 Cloudflare 调用额度失败:', error));
}

// ---------------------------------------------------------------------------
// 视图

function viewColumns(viewerId: number) {
  return {
    row: hostedDomains,
    ownerUsername: users.username,
    memberCount: sql<number>`(SELECT COUNT(*) FROM hosted_domain_members m WHERE m.domain_id = ${hostedDomains.id})`,
    mailboxCount: sql<number>`(SELECT COUNT(*) FROM mailboxes b WHERE b.domain = ${hostedDomains.domain})`,
    isMember: sql<number>`EXISTS (SELECT 1 FROM hosted_domain_members m
      WHERE m.domain_id = ${hostedDomains.id} AND m.user_id = ${viewerId})`,
  };
}

interface ViewRow {
  row: HostedRow;
  ownerUsername: string | null;
  memberCount: number;
  mailboxCount: number;
  isMember: number;
}

function stepsOf(row: HostedRow): HostedDomainSteps {
  const failed = row.status === 'error';
  const state = (ready: boolean): HostedDomainStepState => (ready ? 'ready' : failed ? 'error' : 'waiting');
  return {
    nameServers: row.zoneStatus === 'active' ? 'ready' : row.status === 'moved' ? 'error' : 'waiting',
    routing: state(row.routingStatus === 'ready'),
    catchAll: state(row.catchAllReady),
    sending: state(row.sendingStatus === 'ready'),
  };
}

function warningsOf(row: HostedRow): string[] {
  const warnings: string[] = [];
  if (row.status === 'pending' && row.dnssec) {
    warnings.push('该域名仍开启着 DNSSEC（父域存在 DS 记录）。请先在注册商处关闭 DNSSEC，再修改名称服务器，否则切换后域名将无法解析。');
  }
  if (row.status === 'pending' && /cloudflare/i.test(row.originalRegistrar)) {
    warnings.push('该域名注册在 Cloudflare Registrar，它通常不允许改用其他账户的名称服务器，可能需要先把域名转出到其他注册商。');
  }
  if (row.status === 'moved' && row.zoneStatus === 'missing') {
    warnings.push('Cloudflare 中该域名的 zone 已被删除，收发已停止。点「重新接入」会重新分配名称服务器，地址与历史邮件都保留。');
  } else if (row.status === 'moved') {
    warnings.push('域名的名称服务器已不再指向本站，收发已停止。如需继续使用，请把 NS 改回上面两条。'
      + 'Cloudflare 通常在 7 天后删除已迁走的 zone；删除前改回即可恢复，删除后可点「重新接入」，地址与历史邮件都保留。');
  }
  return warnings;
}

function roleOf(row: HostedRow, viewer: Viewer, isMember: boolean): Access {
  if (row.userId === viewer.id) return 'owner';
  if (viewer.role === 'admin') return 'admin';
  return isMember ? 'member' : null;
}

/** 查看者没有任何权限时返回 null */
function toView(view: ViewRow, viewer: Viewer, pendingDays: number): HostedDomain | null {
  const { row } = view;
  const role = roleOf(row, viewer, Number(view.isMember) === 1);
  if (!role) return null;
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    role,
    ownerUserId: row.userId,
    ownerUsername: view.ownerUsername ?? `user#${row.userId}`,
    nameServers: row.nameServers,
    originalNameServers: row.originalNameServers,
    originalRegistrar: row.originalRegistrar,
    steps: stepsOf(row),
    warnings: warningsOf(row),
    lastError: row.lastError,
    memberLimit: row.memberLimit,
    memberCount: Number(view.memberCount),
    mailboxCount: Number(view.mailboxCount),
    createdAt: row.createdAt.toISOString(),
    activatedAt: iso(row.activatedAt),
    checkedAt: iso(row.checkedAt),
    // 重新接入后的 pending 保留生效时间，不按等待期限删除
    expiresAt: row.status === 'pending' ? new Date(row.createdAt.getTime() + pendingDays * DAY).toISOString() : null,
  };
}

async function loadViews(env: Env, viewer: Viewer, where: SQL | undefined, limit = 500): Promise<HostedDomain[]> {
  const [rows, settings] = await Promise.all([
    createDb(env).select(viewColumns(viewer.id)).from(hostedDomains)
      .leftJoin(users, eq(users.id, hostedDomains.userId))
      .where(where).orderBy(desc(hostedDomains.id)).limit(limit).all(),
    getSettings(env),
  ]);
  return rows.map((row) => toView(row as ViewRow, viewer, settings.hosted_domains.pendingDays))
    .filter((view): view is HostedDomain => view !== null);
}

/** 读取域名并判定查看者身份；没有任何权限时按不存在处理，不暴露他人域名 */
export async function loadAccess(env: Env, viewer: Viewer, id: number): Promise<{ row: HostedRow; access: Exclude<Access, null> }> {
  const db = createDb(env);
  const found = await db.select({
    row: hostedDomains,
    isMember: sql<number>`EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = ${hostedDomains.id} AND m.user_id = ${viewer.id})`,
  }).from(hostedDomains).where(eq(hostedDomains.id, id)).get();
  const access = found ? roleOf(found.row, viewer, Number(found.isMember) === 1) : null;
  if (!found || !access) throw new AppError('not_found', '域名不存在');
  return { row: found.row, access };
}

export function requireManage(access: Exclude<Access, null>): void {
  if (access === 'member') throw new AppError('forbidden', '只有域名所有者或管理员可以执行此操作');
}

interface MeterOptions {
  /** 个人计数的 scope 与每分钟上限 */
  scope: string;
  limit: number;
  /** 计入全站额度的 Cloudflare 调用次数 */
  calls: number;
  /** 能走到 Cloudflare 的条件；不成立的请求不占全站额度 */
  eligible: CounterGuard;
  userBusy: string;
  siteBusy: string;
}

/**
 * 立即检测与 DNS 解析共用的计数：个人按请求数，全站按 Cloudflare 调用次数，合成一个 batch，与读取域名并行。
 * 全站计数的守卫是个人未超限且 eligible 成立；无权访问的请求同样计入个人限额。先判个人与全站超限，再抛读取域名的错误。
 */
export async function meterHostedCall(env: Env, viewer: Viewer, id: number, opts: MeterOptions): Promise<Awaited<ReturnType<typeof loadAccess>>> {
  const window = minuteWindow(1);
  const subject = String(viewer.id);
  const [counted, loaded] = await Promise.allSettled([
    env.db.batch([
      counterStatement(env, opts.scope, subject, window),
      counterStatement(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', window, opts.calls, 0,
        andGuards(counterWithinGuard(opts.scope, subject, window, opts.limit), opts.eligible)),
    ]),
    loadAccess(env, viewer, id),
  ]);
  if (counted.status === 'rejected') throw counted.reason;
  const [user, site] = counted.value;
  if ((counterResult(user)?.count ?? 1) > opts.limit) throw new AppError('rate_limited', opts.userBusy);
  if ((counterResult(site)?.count ?? 0) > MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE) throw new AppError('rate_limited', opts.siteBusy);
  if (loaded.status === 'rejected') throw loaded.reason;
  return loaded.value;
}

export async function getHostedDomain(env: Env, viewer: Viewer, id: number): Promise<HostedDomain> {
  await loadAccess(env, viewer, id);
  const [view] = await loadViews(env, viewer, eq(hostedDomains.id, id), 1);
  if (!view) throw new AppError('not_found', '域名不存在');
  return view;
}

/** 我拥有的与共享给我的（管理员也只看自己的，全站列表走管理员接口） */
export async function listMyHostedDomains(env: Env, viewer: Viewer): Promise<HostedDomain[]> {
  return loadViews(env, viewer, or(
    eq(hostedDomains.userId, viewer.id),
    sql`EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = ${hostedDomains.id} AND m.user_id = ${viewer.id})`,
  ));
}

/** 全站托管域名，按 id 倒序：page 为 null 时返回数组（旧行为，最多 1000 条），否则返回一页 */
export async function listAllHostedDomains(
  env: Env, viewer: Viewer, query: Pick<AdminHostedDomainsQuery, 'status' | 'q'>, page: PageRequest | null = null,
): Promise<HostedDomain[] | Page<HostedDomain>> {
  const conditions: (SQL | undefined)[] = [];
  // 分页按 id 倒序取够即停：status 索引不含 id，走它要先算完该状态全部行的计数子查询再排序，一元 + 让规划器不用它
  if (query.status) conditions.push(page ? sql`+${hostedDomains.status} = ${query.status}` : eq(hostedDomains.status, query.status));
  if (query.q) {
    // instr 按字面匹配，% 和 _ 不当通配符
    conditions.push(or(sql`instr(${hostedDomains.domain}, ${query.q}) > 0`,
      sql`${hostedDomains.userId} IN (SELECT id FROM users WHERE instr(lower(username), ${query.q}) > 0)`));
  }
  if (!page) return loadViews(env, viewer, and(...conditions), 1000);
  if (page.cursorId) conditions.push(lt(hostedDomains.id, page.cursorId));
  // 管理员对每个域名都有权限，loadViews 不会滤掉行，多取的一条照常用来判断下一页
  return toPage(await loadViews(env, viewer, and(...conditions), fetchLimit(page)), page.limit, (view) => view.id);
}

// ---------------------------------------------------------------------------
// 创建

function createZoneError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (!(error instanceof CloudflareApiError)) return new AppError('internal', `Cloudflare 创建域名失败：${errorText(error)}`);
  if (error.has(1061)) return new AppError('conflict', '该域名已存在于 Cloudflare 账户中，不能托管');
  const rejection = zoneCreateRejection(error);
  if (rejection) return rejection;
  if (error.has(1118)) return new AppError('rate_limited', '站长的 Cloudflare 账户暂时不能添加更多域名，请稍后再试或联系管理员');
  return new AppError('internal', `Cloudflare 创建域名失败：${error.message}`);
}

/** 等待生效额度：所有者的 pending 数（管理员操作不受个人额度限制）与全站 pending 数（含系统域名接入） */
function pendingQuotaError(cfg: Settings['hosted_domains'], isAdmin: boolean, ownerPending: number, totalPending: number): AppError | null {
  if (!isAdmin && ownerPending >= cfg.maxPendingPerUser) {
    return new AppError('forbidden', '你还有域名在等待 NS 生效，请先完成或删除后再操作');
  }
  if (totalPending >= cfg.maxPendingTotal) return new AppError('rate_limited', '当前等待生效的域名较多，请稍后再试');
  return null;
}

/** 占位守卫未通过：读回各项条件，给出具体原因 */
async function reservationError(env: Env, viewer: Viewer, domain: string, cfg: Settings['hosted_domains'], window: number): Promise<AppError> {
  const [hosted, listed, used, owned, pending, totalPending, user, site] = await env.db.batch([
    env.db.prepare('SELECT user_id FROM hosted_domains WHERE domain = ?').bind(domain),
    env.db.prepare(`SELECT ${systemDomainListedSql('?1')} AS listed, ${onboardingActiveSql('?1')} AS onboarding`).bind(domain),
    env.db.prepare(`SELECT (EXISTS (SELECT 1 FROM mailboxes WHERE domain = ?1)
      OR EXISTS (SELECT 1 FROM messages WHERE domain = ?1)) AS used`).bind(domain),
    env.db.prepare("SELECT COUNT(*) AS n FROM hosted_domains WHERE user_id = ? AND status <> 'deleting'").bind(viewer.id),
    env.db.prepare("SELECT COUNT(*) AS n FROM hosted_domains WHERE user_id = ? AND status = 'pending'").bind(viewer.id),
    env.db.prepare(`SELECT ${PENDING_ZONES_TOTAL_SQL} AS n`),
    env.db.prepare("SELECT 1 FROM users WHERE id = ? AND status = 'active'").bind(viewer.id),
    counterReadStatement(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', window),
  ]);
  const first = <T>(result: D1Result | undefined) => result?.results?.[0] as T | undefined;
  const holder = first<{ user_id: number }>(hosted);
  if (holder) {
    return new AppError('conflict', Number(holder.user_id) === viewer.id ? '你已经添加过该域名' : '该域名已被其他用户托管');
  }
  if (Number(first<{ listed: number }>(listed)?.listed)) return new AppError('conflict', '该域名已是本站的系统域名');
  if (Number(first<{ onboarding: number }>(listed)?.onboarding)) return new AppError('conflict', '该域名正在作为本站的系统域名接入');
  if (Number(first<{ used: number }>(used)?.used)) {
    return new AppError('conflict', '本站已有该域名的历史地址或邮件，不能作为托管域名添加');
  }
  if (!first(user)) return new AppError('user_disabled', '用户已被禁用');
  const isAdmin = viewer.role === 'admin';
  if (!isAdmin && cfg.maxPerUser > 0 && Number(first<{ n: number }>(owned)?.n) >= cfg.maxPerUser) {
    return new AppError('forbidden', `每人最多托管 ${cfg.maxPerUser} 个域名`);
  }
  if (!isAdmin && Number(first<{ n: number }>(pending)?.n) >= cfg.maxPendingPerUser) {
    return new AppError('forbidden', '你还有域名在等待 NS 生效，请先完成或删除后再添加');
  }
  if (Number(first<{ n: number }>(totalPending)?.n) >= cfg.maxPendingTotal) {
    return new AppError('rate_limited', '当前等待生效的域名较多，请稍后再试');
  }
  if ((counterResult(site)?.count ?? 0) + CREATE_CF_CALLS > MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE) {
    return new AppError('rate_limited', SITE_BUSY);
  }
  return new AppError('conflict', '域名状态已改变，请刷新后重试');
}

/**
 * 添加托管域名：先在 D1 原子占位（唯一性、历史隔离、额度），再在站长账户建 zone。
 * 从不接管账户里已有的同名 zone；建 zone 失败释放占位。能在 NS 生效前做的配置随后在后台尝试。
 */
export async function createHostedDomain(env: Env, viewer: Viewer, domain: string, ctx?: ExecCtx | null, ip = ''): Promise<HostedDomain> {
  // 公开委派预检与读取设置并行（查 RDAP/DoH，不走 Cloudflare API）；先处理下面的快速失败再看它的结论
  const delegation = delegationBlock(env, viewer, domain);
  delegation.catch(() => undefined);
  const settings = await getSettingsFresh(env);
  const creds = requireCredentials(env, settings);
  // 快速失败；与管理员同时把它加为系统域名的竞态由下面占位语句里的守卫兜住
  if (settings.domains.list.some((entry) => entry.domain === domain)) {
    throw new AppError('conflict', '该域名已是本站的系统域名');
  }
  const blocked = await delegation;
  if (blocked) throw blocked;
  const cfg = settings.hosted_domains;
  // 个人计数、占位与全站计数在同一个 batch：超过个人上限或全站额度不够的请求不占位、不占全站额度，
  // 也不会走到 Cloudflare。全站计数只认本次占到的那一行（created_at 写入本次请求的时间戳以区分已有占位）
  const window = minuteWindow(1);
  const reservedAt = Date.now();
  const [userCount, reservation] = await env.db.batch([
    counterStatement(env, HOSTED_CREATE_RATE_SCOPE, String(viewer.id), window),
    env.db.prepare(`INSERT INTO hosted_domains (domain, user_id, status, created_at)
    SELECT ?1, ?2, 'pending', ?11
    WHERE (SELECT count FROM rate_counters WHERE scope = ?7 AND subject = ?8 AND "window" = ?9) <= ?10
      AND COALESCE((SELECT count FROM rate_counters WHERE scope = ?12 AND subject = 'all' AND "window" = ?9), 0) + ?13 <= ?14
      AND NOT EXISTS (SELECT 1 FROM hosted_domains WHERE domain = ?1)
      AND NOT ${systemDomainListedSql('?1')}
      AND NOT ${onboardingActiveSql('?1')}
      AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE domain = ?1)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE domain = ?1)
      AND (?3 = 1 OR ?4 = 0 OR (SELECT COUNT(*) FROM hosted_domains WHERE user_id = ?2 AND status <> 'deleting') < ?4)
      AND (?3 = 1 OR (SELECT COUNT(*) FROM hosted_domains WHERE user_id = ?2 AND status = 'pending') < ?5)
      AND ${PENDING_ZONES_TOTAL_SQL} < ?6
      AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active')
    RETURNING id`)
      .bind(domain, viewer.id, viewer.role === 'admin' ? 1 : 0, cfg.maxPerUser, cfg.maxPendingPerUser, cfg.maxPendingTotal,
        HOSTED_CREATE_RATE_SCOPE, String(viewer.id), window, MAX_HOSTED_CREATES_PER_MINUTE,
        reservedAt, HOSTED_DNS_SITE_RATE_SCOPE, CREATE_CF_CALLS, MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE),
    counterStatement(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', window, CREATE_CF_CALLS, 0, {
      sql: 'EXISTS (SELECT 1 FROM hosted_domains WHERE domain = ? AND user_id = ? AND zone_id IS NULL AND created_at = ?)',
      params: [domain, viewer.id, reservedAt],
    }),
  ]);
  if ((counterResult(userCount)?.count ?? 1) > MAX_HOSTED_CREATES_PER_MINUTE) {
    throw new AppError('rate_limited', '添加域名过于频繁，请稍后再试');
  }
  const reserved = reservation?.results?.[0] as { id: number } | undefined;
  if (!reserved) throw await reservationError(env, viewer, domain, cfg, window);
  const id = Number(reserved.id);

  let zone;
  try {
    if (await findZone(creds, domain)) {
      throw new AppError('conflict', '该域名已存在于站长的 Cloudflare 账户中，不能作为托管域名添加');
    }
    zone = await createZone(creds, domain);
  } catch (error) {
    // 超时或 5xx 时 zone 可能已经建好：保留占位，由定时任务按名称找回或释放
    if (isTransientCloudflareError(error) && !(error instanceof AppError)) {
      throw new AppError('internal', 'Cloudflare 暂时没有响应，系统会在约 10 分钟内确认结果，请稍后刷新「我的域名」查看');
    }
    await env.db.prepare('DELETE FROM hosted_domains WHERE id = ? AND zone_id IS NULL').bind(id).run();
    throw createZoneError(error);
  }
  const dnssec = await hasDnssec(domain).catch(() => false);
  const now = new Date();
  const filled = await createDb(env).update(hostedDomains).set({
    zoneId: zone.id,
    nameServers: zone.name_servers ?? [],
    originalNameServers: zone.original_name_servers ?? [],
    originalRegistrar: zone.original_registrar ?? '',
    zoneStatus: zone.status,
    dnssec,
    checkedAt: now,
    updatedAt: now,
  }).where(and(eq(hostedDomains.id, id), sql`${hostedDomains.zoneId} IS NULL`)).returning({ id: hostedDomains.id });
  if (!filled.length) {
    // 建 zone 期间占位已被删除：不留下没有记录的 zone
    await deleteZone(creds, zone.id, domain, { notBefore: new Date(reservedAt), protectedNames: settings.domains.list.map((entry) => entry.domain) })
      .catch((error) => console.error('回收孤儿 zone 失败:', error));
    throw new AppError('conflict', '该域名已被删除，请重新添加');
  }
  await logAdminAction(env, viewer, 'hosted_domain.create', domain, `zone ${zone.id}，NS ${(zone.name_servers ?? []).join(' / ')}`, ip);
  // catch-all 与发信接入不一定要求 zone 已激活，先尝试；Email Routing 要等 NS 生效后由定时任务补齐
  await runDetached(ctx, '托管域名预配置', async () => {
    await recordSiteCalls(env, PRECONFIGURE_CF_CALLS);
    await preconfigure(env, creds, id);
  });
  return getHostedDomain(env, viewer, id);
}

// ---------------------------------------------------------------------------
// 开通与巡检

interface MailConfig {
  routingStatus: string;
  catchAllReady: boolean;
  sendingStatus: string;
  sendingTag: string | null;
  /** 第一个失败环节的说明；全部成功为空串 */
  error: string;
}

/**
 * 补齐收发配置，每一步先读后写、可重复执行。zoneActive=false 时跳过只能在激活后开启的 Email Routing，
 * 其余步骤的失败由调用方忽略。
 */
async function ensureMailConfig(creds: CloudflareCredentials, row: HostedRow, zoneActive: boolean): Promise<MailConfig> {
  const zoneId = row.zoneId!;
  const out: MailConfig = {
    routingStatus: row.routingStatus, catchAllReady: row.catchAllReady,
    sendingStatus: row.sendingStatus, sendingTag: row.sendingTag, error: '',
  };
  const fail = (step: string, error: unknown) => {
    if (!out.error) out.error = `${step}：${errorText(error)}`;
  };
  // 超时、5xx、限流：结果不确定，保留上次核对的状态，避免一次抖动就挡住收发
  const settled = (error: unknown) => !isTransientCloudflareError(error);

  if (zoneActive) {
    try {
      let routing = await getRouting(creds, zoneId).catch(() => null);
      if (!routing?.enabled || routing.status !== 'ready') routing = await enableRouting(creds, zoneId);
      out.routingStatus = routing.status ?? '';
      if (out.routingStatus !== 'ready') fail('收件路由', `Cloudflare 状态为 ${out.routingStatus || '未知'}`);
    } catch (error) {
      if (settled(error)) out.routingStatus = '';
      fail('收件路由', error);
    }
  }

  try {
    const rule = await getCatchAll(creds, zoneId).catch(() => undefined);
    out.catchAllReady = catchAllTargetsWorker(rule, creds.workerName)
      || catchAllTargetsWorker(await putCatchAll(creds, zoneId), creds.workerName);
    if (!out.catchAllReady) fail('全部地址投递', '规则未指向本站 Worker');
  } catch (error) {
    if (settled(error)) out.catchAllReady = false;
    fail('全部地址投递', error);
  }

  try {
    let tag = out.sendingTag;
    if (!tag) {
      const existing = (await listSendingSubdomains(creds, zoneId)).find((item) => item.name === row.domain);
      tag = existing?.tag ?? (await createSendingSubdomain(creds, zoneId, row.domain)).tag;
    }
    out.sendingTag = tag;
    let status = await getSendingDnsStatus(creds, zoneId, tag);
    if (zoneActive && (status.status === 'unconfigured' || status.status === 'unlocked')) {
      status = await repairSendingDns(creds, zoneId, tag);
    }
    out.sendingStatus = status.status;
    if (status.status !== 'ready') {
      const codes = (status.errors ?? []).map((item) => item.code).join(', ');
      fail('发信', `Cloudflare 状态为 ${status.status}${codes ? `（${codes}）` : ''}`);
    }
  } catch (error) {
    // 发信接入被删除后标签失效：清掉标签，下次重新接入
    if (isCloudflareNotFound(error)) out.sendingTag = null;
    if (settled(error)) out.sendingStatus = '';
    fail('发信', error);
  }
  return out;
}

/**
 * 写回核对结果；暂停与删除中的域名不被并发的巡检改回。带租约时只在仍持有该租约时写入（超时后被别人领走的不覆盖），
 * 并在同一次写入里释放租约。返回是否写入
 */
async function saveChecked(env: Env, id: number, fields: Partial<typeof hostedDomains.$inferInsert>, lease?: Date): Promise<boolean> {
  const saved = await createDb(env).update(hostedDomains)
    .set({ ...fields, ...(lease ? { syncLeaseUntil: null } : {}), updatedAt: new Date() })
    .where(and(eq(hostedDomains.id, id), notInArray(hostedDomains.status, ['suspended', 'deleting']),
      lease ? eq(hostedDomains.syncLeaseUntil, lease) : undefined))
    .returning({ id: hostedDomains.id });
  return saved.length > 0;
}

async function preconfigure(env: Env, creds: CloudflareCredentials, id: number): Promise<void> {
  const row = await createDb(env).select().from(hostedDomains).where(eq(hostedDomains.id, id)).get();
  if (!row?.zoneId) return;
  const config = await ensureMailConfig(creds, row, false);
  await saveChecked(env, id, {
    catchAllReady: config.catchAllReady, sendingTag: config.sendingTag, sendingStatus: config.sendingStatus,
  });
}

/** 删除 zone 与记录（只用于从未生效的 pending 域名，没有地址和邮件） */
async function dropPending(env: Env, creds: CloudflareCredentials, row: HostedRow, reason: string): Promise<void> {
  if (row.zoneId) await deleteZone(creds, row.zoneId, row.domain, await zoneGuard(env, row));
  const guard = "id = ? AND status = 'pending' AND activated_at IS NULL";
  const [, removed] = await env.db.batch([
    tombstoneStatement(env, 'expire', guard, [row.id]),
    env.db.prepare(`DELETE FROM hosted_domains WHERE ${guard}`).bind(row.id),
    env.db.prepare('DELETE FROM hosted_domain_members WHERE domain_id = ?1 AND NOT EXISTS (SELECT 1 FROM hosted_domains WHERE id = ?1)').bind(row.id),
  ]);
  if (removed?.meta.changes) await logAdminAction(env, SYSTEM_ACTOR, 'hosted_domain.expire', row.domain, reason);
}

/**
 * 创建请求在 zone 建好前中断：找回本次创建的 zone，找不到则释放占位（先做可见性自检，Token 看不到账户时保留占位）。
 * 返回租约是否已随写入释放或记录已删除
 */
async function recoverReservation(env: Env, creds: CloudflareCredentials, row: HostedRow, lease: Date): Promise<boolean> {
  if (Date.now() - row.createdAt.getTime() < RESERVATION_STALE_MS) return false;
  const zone = await findZone(creds, row.domain);
  if (zone && zoneCreatedSince(zone, row.createdAt)) {
    const filled = await createDb(env).update(hostedDomains).set({
      zoneId: zone.id, nameServers: zone.name_servers ?? [], originalNameServers: zone.original_name_servers ?? [],
      originalRegistrar: zone.original_registrar ?? '', zoneStatus: zone.status, checkedAt: new Date(), updatedAt: new Date(),
      syncLeaseUntil: null,
    }).where(and(eq(hostedDomains.id, row.id), sql`${hostedDomains.zoneId} IS NULL`, eq(hostedDomains.syncLeaseUntil, lease)))
      .returning({ id: hostedDomains.id });
    return filled.length > 0;
  }
  if (!zone) await assertZonesVisible(creds, '');
  const removed = await env.db.prepare("DELETE FROM hosted_domains WHERE id = ? AND zone_id IS NULL AND status = 'pending'").bind(row.id).run();
  return removed.meta.changes > 0;
}

/**
 * 删除：先永久删除该域名的全部邮件（分批，可跨多次定时任务），再释放地址、撤销共享、
 * 删除 Cloudflare 上的发信接入与 zone，最后删除记录。任一步失败保留 deleting 状态等待重试。
 */
async function teardown(env: Env, creds: CloudflareCredentials, row: HostedRow): Promise<void> {
  // 创建请求可能仍在建 zone：等它回填 zone_id 或超时后再收尾，避免留下没有记录的 zone
  if (!row.zoneId && Date.now() - row.createdAt.getTime() < RESERVATION_STALE_MS) return;
  const deadline = Date.now() + TEARDOWN_PURGE_MS;
  for (;;) {
    const deleted = await purgeMatchingMessages(env, eq(messages.domain, row.domain), 500);
    if (deleted === 0) break;
    if (Date.now() > deadline) return;
  }
  await env.db.batch([
    env.db.prepare('DELETE FROM mailbox_shares WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE domain = ?)').bind(row.domain),
    env.db.prepare('DELETE FROM mailboxes WHERE domain = ?').bind(row.domain),
    env.db.prepare('DELETE FROM hosted_domain_members WHERE domain_id = ?').bind(row.id),
  ]);
  try {
    // 中断的创建请求可能已在 Cloudflare 建好 zone：按名称找回本次创建的 zone 一并删除
    const orphan = row.zoneId ? null : await findZone(creds, row.domain);
    const zoneId = row.zoneId ?? (orphan && zoneCreatedSince(orphan, row.createdAt) ? orphan.id : null);
    if (zoneId) {
      // 发信接入随 zone 删除，单独删除失败不阻塞
      if (row.sendingTag) await deleteSendingSubdomain(creds, zoneId, row.sendingTag).catch(() => undefined);
      await deleteZone(creds, zoneId, row.domain, await zoneGuard(env, row));
    }
  } catch (error) {
    await createDb(env).update(hostedDomains).set({ lastError: `删除 Cloudflare 配置失败：${errorText(error)}`, checkedAt: new Date() })
      .where(eq(hostedDomains.id, row.id));
    return;
  }
  // 删除中的域名拒收、不可认领；进行中的收件仍可能晚到，留到该域没有邮件和地址时再删记录，下一轮继续清理
  // 墓碑与删除同一守卫、同一 batch：记录真正删掉时才留下前所有者与 NS
  const guard = `id = ? AND status = 'deleting'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE domain = ?) AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE domain = ?)`;
  await env.db.batch([
    tombstoneStatement(env, 'delete', guard, [row.id, row.domain, row.domain]),
    env.db.prepare(`DELETE FROM hosted_domains WHERE ${guard}`).bind(row.id, row.domain, row.domain),
  ]);
}

interface SyncOptions {
  /** 等待 NS 时请 Cloudflare 立即复查 */
  activationCheck?: boolean;
  /** 转入 moved 时的提醒放进 waitUntil；没有时（定时任务）同步等待 */
  ctx?: ExecCtx | null;
}

/** 领到的核对：同一批共用一个租约值，写回与释放都以它为准 */
interface SyncClaim {
  row: HostedRow;
  lease: Date;
  /** 可见性自检的参照候选（zone_id） */
  probes: string[];
}

/** 参照候选：最近核对为 active、没有失踪记录的 zone。取两个，保证总有一个不是被核对的域名自己 */
function probeQuery(db: Db) {
  return db.select({ zoneId: hostedDomains.zoneId }).from(hostedDomains)
    .where(and(eq(hostedDomains.status, 'active'), sql`${hostedDomains.zoneMissingAt} IS NULL`, sql`${hostedDomains.zoneId} IS NOT NULL`))
    .orderBy(desc(hostedDomains.checkedAt)).limit(2);
}

const probeIds = (rows: { zoneId: string | null }[]) => rows.flatMap((row) => (row.zoneId ? [row.zoneId] : []));

function credsFor(base: CloudflareCredentials, claim: SyncClaim): CloudflareCredentials {
  const probe = claim.probes.find((zoneId) => zoneId !== claim.row.zoneId);
  return { ...base, probeZone: probe ? { id: probe } : null };
}

/** 领取单个域名的核对租约（暂停的不领），与参照候选同一个 batch；记录不存在或正被别人核对时返回 null */
async function claimOne(env: Env, id: number): Promise<SyncClaim | null> {
  const db = createDb(env);
  const now = Date.now();
  const lease = new Date(now + SYNC_LEASE_MS);
  const [rows, probes] = await db.batch([
    db.update(hostedDomains).set({ syncLeaseUntil: lease })
      .where(and(eq(hostedDomains.id, id), sql`${hostedDomains.status} <> 'suspended'`,
        sql`COALESCE(${hostedDomains.syncLeaseUntil}, 0) < ${now}`))
      .returning(),
    probeQuery(db),
  ]);
  return rows[0] ? { row: rows[0], lease, probes: probeIds(probes) } : null;
}

/**
 * 到期条件：开通中与删除中每轮处理；等待 NS 按创建时长退避（1 小时内每 4 分钟、1 天内每 15 分钟、之后每小时，
 * 只读 zone 状态）；异常与 zone 仍在的已迁走（用户可能改回 NS）每 30 分钟；已生效与 zone 已删除的已迁走每天一次。
 * 每个分支都以 status 等值开头，走 idx_hosted_domains_status
 */
function dueCondition(now: number): SQL {
  return sql`(status IN ('provisioning', 'deleting')
    OR (status = 'pending' AND COALESCE(checked_at, 0) < CASE WHEN created_at > ${now - HOUR} THEN ${now - 4 * MINUTE}
      WHEN created_at > ${now - DAY} THEN ${now - 15 * MINUTE} ELSE ${now - HOUR} END)
    OR (status = 'error' AND COALESCE(checked_at, 0) < ${now - 30 * MINUTE})
    OR (status = 'moved' AND zone_status = 'moved' AND COALESCE(checked_at, 0) < ${now - 30 * MINUTE})
    OR (status IN ('active', 'moved') AND COALESCE(checked_at, 0) < ${now - DAY}))`;
}

/** 一条语句领取一批到期且未被租用的域名（checked_at 最旧优先），领取结果直接当行用；本轮已领过的不再领 */
async function claimDue(env: Env, limit: number, seen: number[]): Promise<{ rows: HostedRow[]; lease: Date; probes: string[] }> {
  const db = createDb(env);
  const now = Date.now();
  const lease = new Date(now + SYNC_LEASE_MS);
  const [rows, probes] = await db.batch([
    db.update(hostedDomains).set({ syncLeaseUntil: lease })
      .where(sql`${hostedDomains.id} IN (SELECT id FROM hosted_domains WHERE ${dueCondition(now)}
        AND COALESCE(sync_lease_until, 0) < ${now} AND id NOT IN (SELECT value FROM json_each(${JSON.stringify(seen)}))
        ORDER BY COALESCE(checked_at, 0) LIMIT ${limit})`)
      .returning(),
    probeQuery(db),
  ]);
  return { rows, lease, probes: probeIds(probes) };
}

async function releaseLeases(env: Env, ids: number[], lease: Date): Promise<void> {
  await createDb(env).update(hostedDomains).set({ syncLeaseUntil: null })
    .where(and(inArray(hostedDomains.id, ids), eq(hostedDomains.syncLeaseUntil, lease)))
    .catch((error) => console.error('释放托管域名核对租约失败:', error));
}

/** 持有租约时核对一次；最后一次写入没有顺带释放租约的（提前返回、写入被守卫拦下、出错）在这里释放 */
async function runClaim(env: Env, base: CloudflareCredentials, claim: SyncClaim, opts: SyncOptions = {}): Promise<void> {
  let released = false;
  try {
    released = await syncClaimed(env, credsFor(base, claim), claim, opts);
  } finally {
    if (!released) await releaseLeases(env, [claim.row.id], claim.lease);
  }
}

/**
 * 托管域名转入 moved 时提醒所有者：按个人通知偏好发飞书与 PushDeer，失败只记日志。Cloudflare 通常 7 天后删除已迁走的 zone，
 * 提醒要赶在这之前
 */
export async function notifyHostedDomainMoved(
  env: Env, row: Pick<HostedRow, 'userId' | 'domain' | 'nameServers' | 'zoneStatus'>, ctx?: ExecCtx | null,
): Promise<void> {
  await runDetached(ctx, '托管域名迁走提醒', async () => {
    const [prefs, fromAddress] = await Promise.all([getUserNotifyPrefs(env, row.userId), getSystemFromAddress(env)]);
    const nameServers = row.nameServers.join('、');
    const lines = row.zoneStatus === 'missing'
      ? [`托管域名 ${row.domain} 在 Cloudflare 中的 zone 已被删除，收发已停止。`, `原分配的名称服务器：${nameServers}`]
      : [`托管域名 ${row.domain} 的名称服务器已不再指向本站，收发已停止。`, `如需继续使用，请到注册商把名称服务器改回：${nameServers}`];
    lines.push('Cloudflare 通常在 7 天后删除已迁走的 zone；删除前把 NS 改回即可恢复，删除后可在域名详情点「重新接入」，地址与历史邮件都保留。');
    const info = {
      subject: `托管域名 ${row.domain} 已停止收发`, fromAddress, fromName: 'HPC Mail', toAddress: row.domain, code: '', body: lines.join('\n'),
    };
    const [feishu, pushdeer] = await Promise.allSettled([
      sendFeishuNotification(prefs.feishu, info), sendPushDeerNotification(prefs.pushdeer, info),
    ]);
    if (feishu.status === 'rejected') console.error('托管域名迁走飞书提醒失败:', feishu.reason);
    if (pushdeer.status === 'rejected') console.error('托管域名迁走 PushDeer 提醒失败:', pushdeer.reason);
  });
}

/** 转为 moved：持有租约，领取时读到的就是旧状态，只有这次写入把其他状态改成 moved 时才提醒一次 */
async function markMoved(
  env: Env, { row, lease }: SyncClaim, fields: Partial<typeof hostedDomains.$inferInsert>, ctx?: ExecCtx | null,
): Promise<boolean> {
  const saved = await saveChecked(env, row.id, { ...fields, status: 'moved' }, lease);
  if (saved && row.status !== 'moved') {
    await emitHostedDomainTransitions(env, row, { status: 'moved', zoneStatus: fields.zoneStatus ?? row.zoneStatus });
    await notifyHostedDomainMoved(env, { ...row, zoneStatus: fields.zoneStatus ?? row.zoneStatus }, ctx);
  }
  return saved;
}

/**
 * zone 已确认不存在（含可见性自检）。从未生效的 pending 域名没有地址和邮件，直接清理；曾生效的先记首次时间，
 * 可收信的转为 error 照常收信，间隔复核仍不存在才判为已迁走，避免一次误判就拒收
 */
async function zoneGone(env: Env, creds: CloudflareCredentials, claim: SyncClaim, now: Date, ctx?: ExecCtx | null): Promise<boolean> {
  const { row, lease } = claim;
  if (row.status === 'pending' && !row.activatedAt) {
    await dropPending(env, creds, row, 'Cloudflare 已删除未激活的 zone');
    return false;
  }
  if (!row.zoneMissingAt) {
    const usable = (HOSTED_DOMAIN_USABLE_STATUSES as readonly string[]).includes(row.status);
    return saveChecked(env, row.id, {
      ...(usable ? { status: 'error' as const } : {}),
      zoneMissingAt: now,
      lastError: `首次发现 Cloudflare 中查不到该域名的 zone，约 30 分钟后复核${usable ? '，期间照常收信' : ''}`,
      checkedAt: now,
    }, lease);
  }
  if (now.getTime() - row.zoneMissingAt.getTime() < MISSING_CONFIRM_MS) return saveChecked(env, row.id, { checkedAt: now }, lease);
  return markMoved(env, claim, { zoneStatus: 'missing', lastError: 'Cloudflare 中的 zone 已不存在', checkedAt: now }, ctx);
}

/**
 * 重新接入后到期仍未改 NS：撤回这次接入，删除新建的 zone 并回到 moved/missing，不再占等待额度；
 * 地址、邮件与成员保留，可以再点「重新接入」。删除 zone 失败保留 pending 等下一轮
 */
async function expireReconnect(env: Env, creds: CloudflareCredentials, claim: SyncClaim, now: Date, pendingDays: number): Promise<boolean> {
  const { row, lease } = claim;
  try {
    if (row.zoneId) await deleteZone(creds, row.zoneId, row.domain, await zoneGuard(env, row));
  } catch (error) {
    return saveChecked(env, row.id, { lastError: `撤回到期的重新接入失败：${errorText(error)}`, checkedAt: now }, lease);
  }
  return saveChecked(env, row.id, {
    status: 'moved', zoneStatus: 'missing', zoneMissingAt: now, routingStatus: '', catchAllReady: false, sendingStatus: '', sendingTag: null,
    lastError: `重新接入后 ${pendingDays} 天内未完成 NS 修改，已撤回；改好 NS 前可再次重新接入`, checkedAt: now,
  }, lease);
}

/**
 * 持有租约时与 Cloudflare 核对一次并推进状态。zone 未激活：刷新 NS 与 DNSSEC，到期删除；
 * 已激活：补齐收发配置，全部就绪为 active，否则 provisioning（宽限期内）或 error。读到 zone 就清掉失踪记录。
 * 返回租约是否已随最后一次写入释放（或记录已删除）
 */
async function syncClaimed(env: Env, creds: CloudflareCredentials, claim: SyncClaim, opts: SyncOptions): Promise<boolean> {
  const { row, lease } = claim;
  if (row.status === 'deleting') {
    await teardown(env, creds, row);
    return false;
  }
  if (!row.zoneId) return recoverReservation(env, creds, row, lease);

  const now = new Date();
  let zone;
  try {
    zone = await getZone(creds, row.zoneId, row.domain);
  } catch (error) {
    return saveChecked(env, row.id, { lastError: `查询 Cloudflare 失败：${errorText(error)}`, checkedAt: now }, lease);
  }
  if (!zone) return zoneGone(env, creds, claim, now, opts.ctx);
  if (zone.status === 'pending' || zone.status === 'initializing') {
    const { hosted_domains: cfg } = await getSettings(env);
    if (row.status === 'pending' && now.getTime() > row.createdAt.getTime() + cfg.pendingDays * DAY) {
      if (!row.activatedAt) {
        await dropPending(env, creds, row, `${cfg.pendingDays} 天内未完成 NS 修改，已自动删除`);
        return false;
      }
      return expireReconnect(env, creds, claim, now, cfg.pendingDays);
    }
    if (opts.activationCheck) await requestActivationCheck(creds, zone.id);
    const dnssec = await hasDnssec(row.domain).catch(() => row.dnssec);
    return saveChecked(env, row.id, {
      status: 'pending', zoneStatus: zone.status, nameServers: zone.name_servers ?? row.nameServers,
      dnssec, zoneMissingAt: null, lastError: '', checkedAt: now,
    }, lease);
  }
  if (zone.status === 'moved') {
    return markMoved(env, claim, {
      zoneStatus: 'moved', zoneMissingAt: null, lastError: '域名的名称服务器已不再指向本站', checkedAt: now,
    }, opts.ctx);
  }
  const activatedAt = row.activatedAt ?? (zone.activated_on ? new Date(zone.activated_on) : now);
  const config = await ensureMailConfig(creds, row, true);
  // 发信就绪后订阅投递回执（失败只记录在订阅状态里，不影响开通）
  if (config.sendingStatus === 'ready') await subscribeHostedDomainEvents(env, creds, row.domain, zone.id);
  const ready = config.routingStatus === 'ready' && config.catchAllReady && config.sendingStatus === 'ready';
  const status = ready ? 'active' : now.getTime() - activatedAt.getTime() > PROVISION_GRACE_MS ? 'error' : 'provisioning';
  const saved = await saveChecked(env, row.id, {
    status,
    zoneStatus: 'active',
    activatedAt,
    routingStatus: config.routingStatus,
    catchAllReady: config.catchAllReady,
    sendingStatus: config.sendingStatus,
    sendingTag: config.sendingTag,
    dnssec: false,
    zoneMissingAt: null,
    lastError: ready ? '' : config.error,
    checkedAt: now,
  }, lease);
  // Webhook v2：可以收信、发信就绪的状态变化（只在这次写入生效时）
  if (saved) await emitHostedDomainTransitions(env, row, { status, zoneStatus: 'active', ...config });
  return saved;
}

/** 核对单个域名：先领租约，正被其他请求或定时任务核对（或已暂停、不存在）时不调用 Cloudflare */
export async function syncHostedDomain(env: Env, id: number, opts: SyncOptions = {}): Promise<void> {
  const base = cloudflareCredentials(env);
  if (!base) return;
  const claim = await claimOne(env, id);
  if (claim) await runClaim(env, base, claim, opts);
}

/**
 * 定时任务：按到期条件分批领取租约并发处理，在时间预算内循环领取下一批；到期没处理的释放租约留给下一轮。
 * 返回处理的域名数
 */
export async function syncDueHostedDomains(env: Env, limit = 10): Promise<number> {
  const base = cloudflareCredentials(env);
  if (!base) return 0;
  const deadline = Date.now() + SYNC_BUDGET_MS;
  const seen: number[] = [];
  let processed = 0;
  while (Date.now() < deadline) {
    const batch = await claimDue(env, limit, seen);
    if (!batch.rows.length) break;
    seen.push(...batch.rows.map((row) => row.id));
    const skipped: number[] = [];
    await runLimited(batch.rows, SYNC_CONCURRENCY, async (row) => {
      if (Date.now() >= deadline) {
        skipped.push(row.id);
        return;
      }
      processed++;
      try {
        await runClaim(env, base, { row, lease: batch.lease, probes: batch.probes });
      } catch (error) {
        console.error(`托管域名 #${row.id} 核对失败:`, error);
      }
    });
    if (skipped.length) await releaseLeases(env, skipped, batch.lease);
    if (batch.rows.length < limit) break;
  }
  return processed;
}

/** 用户点「立即检测」：等待 NS 时请 Cloudflare 立即复查，再核对并推进开通 */
export async function checkHostedDomain(env: Env, viewer: Viewer, id: number, ctx?: ExecCtx | null): Promise<HostedDomain> {
  // 全站计数的条件与下面实际触发核对的一致：功能开着且有凭据、所有者或管理员、未暂停或删除、过了节流间隔、没有正被核对
  const settings = await getSettings(env);
  const now = Date.now();
  const { row, access } = await meterHostedCall(env, viewer, id, {
    scope: HOSTED_CHECK_RATE_SCOPE, limit: MAX_HOSTED_CHECKS_PER_MINUTE, calls: CHECK_CF_CALLS,
    eligible: {
      sql: `? = 1 AND EXISTS (SELECT 1 FROM hosted_domains WHERE id = ? AND (user_id = ? OR ? = 1)
        AND status NOT IN ('suspended', 'deleting') AND COALESCE(checked_at, 0) <= ? AND COALESCE(sync_lease_until, 0) < ?)`,
      params: [hostedDomainsAvailable(env, settings) ? 1 : 0, id, viewer.id, viewer.role === 'admin' ? 1 : 0,
        now - CHECK_THROTTLE_MS, now],
    },
    userBusy: '检测过于频繁，请稍后再试',
    siteBusy: SITE_BUSY,
  });
  requireManage(access);
  requireCredentials(env, settings);
  const recent = row.checkedAt && Date.now() - row.checkedAt.getTime() < CHECK_THROTTLE_MS;
  if (!recent && row.status !== 'suspended' && row.status !== 'deleting') {
    await syncHostedDomain(env, id, { activationCheck: row.status === 'pending', ctx });
  }
  return getHostedDomain(env, viewer, id);
}

/**
 * zone 已被删除时重建：同名 zone 只采用上次中断的重新接入建出的（创建时间不早于首次失踪时间前 1 分钟），其他一律不接管；
 * 找不到就新建。回填后回到 pending，保留生效时间、地址、邮件与成员。返回租约是否已随回填释放
 */
async function rebuildZone(
  env: Env, creds: CloudflareCredentials, claim: SyncClaim, viewer: Viewer, settings: Settings, ctx?: ExecCtx | null, ip = '',
): Promise<boolean> {
  const protectedNames = settings.domains.list.map((entry) => entry.domain);
  const cfg = settings.hosted_domains;
  const isAdmin = viewer.role === 'admin';
  const { row, lease } = claim;
  const db = createDb(env);
  const now = new Date();
  let missingSince = row.zoneMissingAt;
  if (!missingSince) {
    // 没有失踪记录（失踪复核上线前就已迁走的）：以本次确认为准并先记下，中断后再点能认出本次建的 zone
    missingSince = now;
    await db.update(hostedDomains).set({ zoneMissingAt: now })
      .where(and(eq(hostedDomains.id, row.id), eq(hostedDomains.syncLeaseUntil, lease)));
  }
  let zone: CfZone | null;
  let created = false;
  // 重建出的 zone 同样占等待生效额度（与添加同一口径）：先查额度再动 Cloudflare，回填时由守卫复核
  const [found, quota] = await Promise.allSettled([
    findZone(creds, row.domain),
    env.db.batch([
      env.db.prepare("SELECT COUNT(*) AS n FROM hosted_domains WHERE user_id = ? AND status = 'pending'").bind(row.userId),
      env.db.prepare(`SELECT ${PENDING_ZONES_TOTAL_SQL} AS n`),
    ]),
  ]);
  if (quota.status === 'rejected') throw quota.reason;
  const [ownerPending, totalPending] = quota.value.map((result) => Number((result.results?.[0] as { n: number } | undefined)?.n ?? 0));
  const overQuota = pendingQuotaError(cfg, isAdmin, ownerPending!, totalPending!);
  if (overQuota) throw overQuota;
  if (found.status === 'rejected') throw new AppError('internal', `查询 Cloudflare 失败，请稍后重试：${errorText(found.reason)}`);
  zone = found.value;
  if (zone && !zoneCreatedSince(zone, missingSince)) {
    throw new AppError('conflict', '站长账户中已有同名 zone，不能接管');
  }
  if (!zone) {
    try {
      zone = await createZone(creds, row.domain);
      created = true;
    } catch (error) {
      // 结果不确定时 zone 可能已经建好：下次再点按创建时间采用
      if (isTransientCloudflareError(error)) throw new AppError('internal', 'Cloudflare 暂时没有响应，请稍后再点「重新接入」');
      throw createZoneError(error);
    }
  }
  const filled = await db.update(hostedDomains).set({
    zoneId: zone.id,
    nameServers: zone.name_servers ?? [],
    originalNameServers: zone.original_name_servers ?? [],
    originalRegistrar: zone.original_registrar ?? '',
    zoneStatus: zone.status,
    status: 'pending',
    routingStatus: '',
    catchAllReady: false,
    sendingStatus: '',
    sendingTag: null,
    zoneMissingAt: null,
    lastError: '',
    checkedAt: now,
    syncLeaseUntil: null,
    // 重新接入从这个 zone 起算：等待 NS 的退避、到期撤回与 expiresAt 都按它（不早于 zone 的创建时间，删除核对身份时用）
    createdAt: zone.created_on ? new Date(Math.min(now.getTime(), new Date(zone.created_on).getTime())) : now,
    updatedAt: now,
  }).where(and(eq(hostedDomains.id, row.id), eq(hostedDomains.status, 'moved'), eq(hostedDomains.syncLeaseUntil, lease),
    // 查额度与回填之间可能有别的添加或重新接入：回填时按同样条件复核
    sql`(${isAdmin ? 1 : 0} = 1 OR (SELECT COUNT(*) FROM hosted_domains p WHERE p.user_id = ${row.userId} AND p.status = 'pending') < ${cfg.maxPendingPerUser})`,
    sql`${sql.raw(PENDING_ZONES_TOTAL_SQL)} < ${cfg.maxPendingTotal}`))
    .returning({ id: hostedDomains.id });
  if (!filled.length) {
    // 期间被暂停、删除、租约超时被别人领走或额度被占满：不留下没有记录的 zone
    if (created) {
      await deleteZone(creds, zone.id, row.domain, { notBefore: now, protectedNames })
        .catch((error) => console.error('回收孤儿 zone 失败:', error));
    }
    const current = await env.db.batch([
      env.db.prepare("SELECT COUNT(*) AS n FROM hosted_domains WHERE user_id = ? AND status = 'pending'").bind(row.userId),
      env.db.prepare(`SELECT ${PENDING_ZONES_TOTAL_SQL} AS n`),
    ]);
    const [ownerNow, totalNow] = current.map((result) => Number((result.results?.[0] as { n: number } | undefined)?.n ?? 0));
    throw pendingQuotaError(cfg, isAdmin, ownerNow!, totalNow!) ?? new AppError('conflict', '域名状态已改变，请刷新后重试');
  }
  await logAdminAction(env, viewer, 'hosted_domain.reconnect', row.domain,
    `zone ${zone.id}${created ? '' : '（采用上次中断时建出的）'}，NS ${(zone.name_servers ?? []).join(' / ')}`, ip);
  await runDetached(ctx, '托管域名预配置', async () => {
    await recordSiteCalls(env, PRECONFIGURE_CF_CALLS);
    await preconfigure(env, creds, row.id);
  });
  return true;
}

/**
 * 重新接入已迁走的域名（所有者或管理员）：zone 仍在时请 Cloudflare 复查 NS 并核对一次，返回最新状态；
 * zone 已被删除（经可见性自检确认）时重建 zone 并回到 pending，用户需要把 NS 改成新分配的两条。
 * 正被其他请求或定时任务核对时不调用 Cloudflare，直接返回当前状态
 */
export async function reconnectHostedDomain(env: Env, viewer: Viewer, id: number, ctx?: ExecCtx | null, ip = ''): Promise<HostedDomain> {
  // 全站计数的条件与实际会调用 Cloudflare 的条件一致：功能开着且有凭据、所有者或管理员、已迁走、没有正被核对
  const settings = await getSettings(env);
  const { row, access } = await meterHostedCall(env, viewer, id, {
    scope: HOSTED_CREATE_RATE_SCOPE, limit: MAX_HOSTED_CREATES_PER_MINUTE, calls: RECONNECT_CF_CALLS,
    eligible: {
      sql: `? = 1 AND EXISTS (SELECT 1 FROM hosted_domains WHERE id = ? AND (user_id = ? OR ? = 1)
        AND status = 'moved' AND COALESCE(sync_lease_until, 0) < ?)`,
      params: [hostedDomainsAvailable(env, settings) ? 1 : 0, id, viewer.id, viewer.role === 'admin' ? 1 : 0, Date.now()],
    },
    userBusy: '重新接入过于频繁，请稍后再试',
    siteBusy: SITE_BUSY,
  });
  requireManage(access);
  const base = requireCredentials(env, settings);
  if (row.status !== 'moved') throw new AppError('conflict', '只有名称服务器已改走的域名可以重新接入');
  const claim = await claimOne(env, id);
  if (!claim) return getHostedDomain(env, viewer, id);
  let released = false;
  try {
    if (claim.row.status !== 'moved') throw new AppError('conflict', '域名状态已改变，请刷新后重试');
    const creds = credsFor(base, claim);
    let zone: CfZone | null;
    try {
      zone = claim.row.zoneId ? await getZone(creds, claim.row.zoneId, claim.row.domain) : null;
    } catch (error) {
      throw new AppError('internal', `查询 Cloudflare 失败，请稍后重试：${errorText(error)}`);
    }
    if (zone) {
      // NS 可能已改回：请 Cloudflare 立即复查，再按正常流程核对一次
      await requestActivationCheck(creds, zone.id);
      released = await syncClaimed(env, creds, claim, { ctx });
    } else {
      released = await rebuildZone(env, creds, claim, viewer, settings, ctx, ip);
    }
  } finally {
    if (!released) await releaseLeases(env, [id], claim.lease);
  }
  return getHostedDomain(env, viewer, id);
}

// ---------------------------------------------------------------------------
// 设置、删除、成员、过户

export async function updateHostedDomain(env: Env, viewer: Viewer, id: number, memberLimit: number, ip = ''): Promise<HostedDomain> {
  const { row, access } = await loadAccess(env, viewer, id);
  requireManage(access);
  if (row.status === 'deleting') throw new AppError('conflict', '域名正在删除');
  await createDb(env).update(hostedDomains).set({ memberLimit, updatedAt: new Date() }).where(eq(hostedDomains.id, id));
  if (row.memberLimit !== memberLimit) {
    await logAdminAction(env, viewer, 'hosted_domain.update', row.domain, `成员认领上限 ${row.memberLimit}→${memberLimit}`, ip);
  }
  return getHostedDomain(env, viewer, id);
}

/** 进入删除中：立即拒收、停止认领与发信，后台清理邮件、地址与 Cloudflare 配置 */
export async function deleteHostedDomain(env: Env, viewer: Viewer, id: number, ctx?: ExecCtx | null, ip = ''): Promise<void> {
  const { row, access } = await loadAccess(env, viewer, id);
  requireManage(access);
  if (row.status !== 'deleting') {
    // 普通用户按读到的归属复核，避免与并发过户交错时删掉已过户给别人的域名
    const updated = await createDb(env).update(hostedDomains).set({ status: 'deleting', lastError: '', updatedAt: new Date() })
      .where(and(eq(hostedDomains.id, id), notInArray(hostedDomains.status, ['deleting']),
        access === 'admin' ? undefined : eq(hostedDomains.userId, row.userId)))
      .returning({ id: hostedDomains.id });
    if (updated.length) {
      await logAdminAction(env, viewer, 'hosted_domain.delete', row.domain, `所有者 #${row.userId}，地址与邮件将永久删除`, ip);
    } else if (access !== 'admin') {
      throw new AppError('conflict', '域名归属已改变，请刷新后重试');
    }
  }
  // 删除只计入全站额度、不因额度拒绝
  await runDetached(ctx, '托管域名删除', async () => {
    await recordSiteCalls(env, TEARDOWN_CF_CALLS);
    await syncHostedDomain(env, id);
  });
}

export async function listHostedDomainMembers(env: Env, viewer: Viewer, id: number): Promise<HostedDomainMember[]> {
  const { row, access } = await loadAccess(env, viewer, id);
  requireManage(access);
  const rows = await createDb(env).select({
    userId: hostedDomainMembers.userId,
    username: users.username,
    status: users.status,
    grantedAt: hostedDomainMembers.createdAt,
    mailboxCount: sql<number>`(SELECT COUNT(*) FROM mailboxes b WHERE b.user_id = ${hostedDomainMembers.userId} AND b.domain = ${row.domain})`,
  }).from(hostedDomainMembers)
    .innerJoin(users, eq(users.id, hostedDomainMembers.userId))
    .where(eq(hostedDomainMembers.domainId, id))
    .orderBy(hostedDomainMembers.createdAt).all();
  return rows.map((member) => ({
    userId: member.userId, username: member.username, status: member.status,
    grantedAt: member.grantedAt.toISOString(), mailboxCount: Number(member.mailboxCount),
  }));
}

/** 替换成员名单；被移除的成员保留已认领的地址，只失去新增认领的权限 */
export async function replaceHostedDomainMembers(
  env: Env, viewer: Viewer, id: number, userIds: number[], expectedOwnerId: number, ip = '',
): Promise<HostedDomainMember[]> {
  const { row, access } = await loadAccess(env, viewer, id);
  requireManage(access);
  if (row.status === 'deleting') throw new AppError('conflict', '域名正在删除');
  if (row.userId !== expectedOwnerId) throw new AppError('conflict', '域名归属已改变，请刷新后重试');
  const unique = [...new Set(userIds)];
  if (unique.includes(row.userId)) throw new AppError('validation_failed', '不能把所有者加为成员');
  const before = await listHostedDomainMembers(env, viewer, id);
  // 只校验新增的人：已被禁用的现有成员可以留在名单里，不妨碍添加其他人
  const added = unique.filter((userId) => !before.some((member) => member.userId === userId));
  if (added.length) {
    // 一次最多新增 100 人，连同 status 超过 D1 的 100 个绑定参数：分批放进同一个 batch，仍是一次往返
    const db = createDb(env);
    const active = await env.db.batch(chunk(added).map((batch) => d1Statement(env,
      db.select({ id: users.id }).from(users).where(and(inArray(users.id, batch), eq(users.status, 'active'))))));
    const activeCount = active.reduce((total, part) => total + part.results.length, 0);
    if (activeCount !== added.length) throw new AppError('validation_failed', '只能共享给启用中的用户');
  }
  const ids = JSON.stringify(unique);
  const ownerGuard = `EXISTS (SELECT 1 FROM hosted_domains WHERE id = ?1 AND user_id = ?2 AND status <> 'deleting')`;
  await env.db.batch([
    env.db.prepare(`DELETE FROM hosted_domain_members WHERE domain_id = ?1
      AND user_id NOT IN (SELECT value FROM json_each(?3)) AND ${ownerGuard}`).bind(id, expectedOwnerId, ids),
    env.db.prepare(`INSERT OR IGNORE INTO hosted_domain_members (domain_id, user_id, granted_by)
      SELECT ?1, value, ?4 FROM json_each(?3) WHERE ${ownerGuard}`).bind(id, expectedOwnerId, ids, viewer.id),
  ]);
  const current = await createDb(env).select({ userId: hostedDomains.userId }).from(hostedDomains).where(eq(hostedDomains.id, id)).get();
  if (current?.userId !== expectedOwnerId) throw new AppError('conflict', '域名归属已改变，请刷新后重试');
  const after = await listHostedDomainMembers(env, viewer, id);
  const beforeNames = new Set(before.map((member) => member.username));
  const afterNames = new Set(after.map((member) => member.username));
  const joined = [...afterNames].filter((name) => !beforeNames.has(name));
  const left = [...beforeNames].filter((name) => !afterNames.has(name));
  if (joined.length || left.length) {
    await logAdminAction(env, viewer, 'hosted_domain.members', row.domain,
      [joined.length ? `+${joined.join('、')}` : '', left.length ? `−${left.join('、')}` : ''].filter(Boolean).join(' '), ip);
  }
  return after;
}

/** 移除成员；成员本人可以退出共享 */
export async function removeHostedDomainMember(env: Env, viewer: Viewer, id: number, userId: number, ip = ''): Promise<void> {
  const { row, access } = await loadAccess(env, viewer, id);
  if (!(access === 'member' && userId === viewer.id)) requireManage(access);
  const result = await env.db.prepare('DELETE FROM hosted_domain_members WHERE domain_id = ? AND user_id = ?').bind(id, userId).run();
  if (result.meta.changes) {
    await logAdminAction(env, viewer, 'hosted_domain.members', row.domain, userId === viewer.id ? '成员退出共享' : `移除成员 #${userId}`, ip);
  }
}

/**
 * 过户：所有权、移除新所有者的成员身份、（可选）原所有者地址连同历史一起过户并撤销其邮箱共享、审计，
 * 同一 D1 事务。用户发起时受对方托管数量上限约束，管理员不受限。
 */
export async function transferHostedDomain(
  env: Env, viewer: Viewer, id: number, req: TransferHostedDomainRequest, ip = '',
): Promise<HostedDomainTransferResult> {
  const { row, access } = await loadAccess(env, viewer, id);
  requireManage(access);
  if (row.status === 'deleting') throw new AppError('conflict', '域名正在删除');
  const db = createDb(env);
  const target = await db.select().from(users).where(eq(users.id, req.userId)).get();
  if (!target) throw new AppError('not_found', '目标用户不存在');
  if (target.status !== 'active') throw new AppError('validation_failed', '只能过户给启用中的用户');
  const resultFor = async (transferred: boolean, movedMailboxes: number): Promise<HostedDomainTransferResult> => ({
    domain: (await loadViews(env, viewer, eq(hostedDomains.id, id), 1))[0] ?? null,
    previousUserId: transferred ? req.expectedOwnerId : row.userId,
    transferred,
    movedMailboxes,
  });
  // 重试已完成的过户直接返回，不重复移动地址或记审计
  if (row.userId === target.id) return resultFor(false, 0);
  if (row.userId !== req.expectedOwnerId) throw new AppError('conflict', '域名归属已改变，请刷新后重新确认');
  const { hosted_domains: cfg } = await getSettingsFresh(env);
  const limit = viewer.role === 'admin' ? 0 : cfg.maxPerUser;
  const previous = await db.select({ username: users.username }).from(users).where(eq(users.id, row.userId)).get();
  // 本次过户写入的 updated_at 作为标记：后续语句只在过户真正发生时执行
  const marker = Date.now();
  const moved = `EXISTS (SELECT 1 FROM hosted_domains WHERE id = ? AND user_id = ? AND updated_at = ?)`;
  const statements = [
    env.db.prepare(`UPDATE hosted_domains SET user_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status <> 'deleting'
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
        AND (? = 0 OR (SELECT COUNT(*) FROM hosted_domains WHERE user_id = ? AND status <> 'deleting') < ?)`)
      .bind(target.id, marker, id, req.expectedOwnerId, target.id, limit, target.id, limit),
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?, ?, 'hosted_domain.transfer', ?, ?, ? WHERE changes() = 1`)
      .bind(viewer.id, viewer.username, row.domain,
        `${previous?.username ?? `user#${row.userId}`} (#${row.userId}) → ${target.username} (#${target.id})`
        + (req.includeMailboxes ? '；地址连同历史一起过户' : '；原所有者保留已认领地址'), ip),
    env.db.prepare(`DELETE FROM hosted_domain_members WHERE domain_id = ? AND user_id = ? AND ${moved}`)
      .bind(id, target.id, id, target.id, marker),
  ];
  if (req.includeMailboxes) {
    statements.push(
      env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE domain = ? AND user_id = ?)
        AND ${moved}`).bind(row.domain, req.expectedOwnerId, id, target.id, marker),
      env.db.prepare(`UPDATE mailboxes SET user_id = ? WHERE domain = ? AND user_id = ? AND ${moved}`)
        .bind(target.id, row.domain, req.expectedOwnerId, id, target.id, marker),
    );
  }
  const results = await env.db.batch(statements);
  if (!results[0]?.meta.changes) {
    const current = await db.select({ userId: hostedDomains.userId }).from(hostedDomains).where(eq(hostedDomains.id, id)).get();
    if (current?.userId === target.id) return resultFor(false, 0);
    if (limit > 0 && current?.userId === req.expectedOwnerId) throw new AppError('forbidden', `对方托管的域名数已达上限（${limit}）`);
    throw new AppError('conflict', '域名归属或目标用户状态已改变，请刷新后重新确认');
  }
  return resultFor(true, req.includeMailboxes ? (results[4]?.meta.changes ?? 0) : 0);
}

// ---------------------------------------------------------------------------
// 管理员

export async function suspendHostedDomain(env: Env, viewer: Viewer, id: number, ip = ''): Promise<HostedDomain> {
  const { row } = await loadAccess(env, viewer, id);
  if (row.status === 'deleting') throw new AppError('conflict', '域名正在删除');
  const updated = await createDb(env).update(hostedDomains).set({ status: 'suspended', updatedAt: new Date() })
    .where(and(eq(hostedDomains.id, id), notInArray(hostedDomains.status, ['suspended', 'deleting']))).returning({ id: hostedDomains.id });
  if (updated.length) await logAdminAction(env, viewer, 'hosted_domain.suspend', row.domain, '', ip);
  return getHostedDomain(env, viewer, id);
}

/** 恢复后立即核对一次，按 Cloudflare 实际状态回到 pending / provisioning / active 等 */
export async function resumeHostedDomain(env: Env, viewer: Viewer, id: number, ip = ''): Promise<HostedDomain> {
  const { row } = await loadAccess(env, viewer, id);
  const updated = await createDb(env).update(hostedDomains).set({ status: 'provisioning', updatedAt: new Date() })
    .where(and(eq(hostedDomains.id, id), eq(hostedDomains.status, 'suspended'))).returning({ id: hostedDomains.id });
  if (updated.length) {
    await logAdminAction(env, viewer, 'hosted_domain.resume', row.domain, '', ip);
    await syncHostedDomain(env, id);
  }
  return getHostedDomain(env, viewer, id);
}

export async function hostedDomainsHealth(env: Env): Promise<HostedDomainsHealth> {
  const settings = await getSettings(env);
  const creds = cloudflareCredentials(env);
  const base: HostedDomainsHealth = {
    enabled: settings.hosted_domains.enabled, configured: creds !== null,
    tokenValid: null, error: '', accountZones: null, accountPendingZones: null,
  };
  if (!creds) return base;
  try {
    await verifyToken(creds);
    const zones = await countZones(creds);
    return { ...base, tokenValid: true, accountZones: zones.total, accountPendingZones: zones.pending };
  } catch (error) {
    return { ...base, tokenValid: false, error: errorText(error) };
  }
}
