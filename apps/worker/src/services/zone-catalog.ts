/**
 * 系统域名接入的只读侧：Cloudflare 调用额度与全局 429 退避、账户 zone 列表与分类、预检（existing_zone / new_zone）、隐藏列表。
 * zone 归属以 D1 为准（站长账户里的 zone 在 Cloudflare 上看不出是系统还是托管）：
 * system（在系统域名列表）> hosted（hosted_domains，zone id 不一致为 inconsistent）> onboarding（进行中的接入任务）> available。
 * 预检只读、不吞错：读取失败是 unknown 并阻断写入，绝不推断为「不存在」。
 */
import {
  DEFAULT_SETTINGS, SYSTEM_DOMAIN_ACKS, SYSTEM_DOMAIN_ZONE_CATEGORIES, domainSchema,
  type DnssecState, type SystemDomainAck, type SystemDomainCheck, type SystemDomainCheckKey, type SystemDomainCheckState,
  type SystemDomainHiddenZones, type SystemDomainOnboardingMode, type SystemDomainOnboardingSummary, type SystemDomainPrecheck,
  type SystemDomainRegistrar, type SystemDomainSeverity, type SystemDomainVerdict, type SystemDomainZone, type SystemDomainZoneCategory,
  type SystemDomainZoneOrigin, type SystemDomainZoneReadiness, type SystemDomainZonesQuery, type SystemDomainZonesView,
  type UpdateSystemDomainHiddenZonesRequest,
} from '@hpc-mail/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import {
  hostedDomains, settings, systemDomainOnboarding, users,
  type OnboardingAcceptance, type OnboardingPreflightSnapshot,
} from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Env } from '../types.js';
import { logAdminAction } from './audit.js';
import {
  CloudflareApiError, cloudflareCredentials, findZone, getZone, listAccountZones,
  type CfPage, type CfZone, type CloudflareCredentials,
} from './cloudflare.js';
import {
  ACTIVE_ONBOARDING_COUNT_SQL, hostedTakenSql, ONBOARDING_TERMINAL_SQL, SYSTEM_DOMAIN_COUNT_SQL, SYSTEM_PENDING_ZONES_SQL,
  systemDomainListedSql,
} from './domain-occupancy.js';
import {
  dnssecState, fingerprintOf, INSPECT_CF_CALLS, inspectMailConfig, lookupRegistrar, planMailChanges, type MailInspection, type MailPlan,
} from './mail-provisioning.js';
import { counterResult, counterStatement, minuteWindow, type CounterGuard } from './rate-counter.js';
import { mergeSettingRows } from './setting.js';

type OnboardingRow = typeof systemDomainOnboarding.$inferSelect;
type Actor = Pick<AuthUser, 'id' | 'username'>;

/** 系统域名列表上限（与 shared domainsSettingSchema 一致）；进行中的接入任务也占名额 */
export const MAX_SYSTEM_DOMAINS = 64;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 系统域名接入只看 Worker 是否配了 Cloudflare 凭据，不受托管域名开关影响 */
export function requireCredentials(env: Env): CloudflareCredentials {
  const creds = cloudflareCredentials(env);
  if (!creds) throw new AppError('forbidden', '本站 Worker 未配置 Cloudflare 凭据，不能自动接入系统域名');
  return creds;
}

// ---------------------------------------------------------------------------
// Cloudflare 调用额度（每 5 分钟 120 次，按估算调用数预占）与全局 429 退避

export const SYSTEM_DOMAIN_CF_SCOPE = 'system_domain_cf';
export const SYSTEM_DOMAIN_CF_WINDOW_MINUTES = 5;
export const MAX_SYSTEM_DOMAIN_CF_CALLS = 120;
/** 全局退避（settings 行 cf_backoff，{"until": 毫秒}，不进 SETTING_SCHEMAS）：收到 429 后至少停 5 分钟 */
const MIN_BACKOFF_SECONDS = 300;
const BACKOFF_UNTIL_SQL = "COALESCE((SELECT json_extract(value, '$.until') FROM settings WHERE key = 'cf_backoff'), 0)";

export const cfWindow = (now = Date.now()): number => minuteWindow(SYSTEM_DOMAIN_CF_WINDOW_MINUTES, now);

/** 守卫：本窗口已用 + calls 不超过上限，且不在 429 退避期内（匿名 ? 绑定，可直接作为 counterStatement 的 guard） */
export function cfBudgetGuard(calls: number, now = Date.now()): CounterGuard {
  return {
    sql: `COALESCE((SELECT count FROM rate_counters WHERE scope = ? AND subject = 'all' AND "window" = ?), 0) + ? <= ?
      AND ${BACKOFF_UNTIL_SQL} <= ?`,
    params: [SYSTEM_DOMAIN_CF_SCOPE, cfWindow(now), calls, MAX_SYSTEM_DOMAIN_CF_CALLS, now],
  };
}

export const cfBusyError = (): AppError => new AppError('rate_limited', 'Cloudflare 接口繁忙，请稍后再试');

/** 预占 calls 次调用额度（与退避检查同一条语句）；不够或在退避期内返回 false */
export async function reserveCfCalls(env: Env, calls: number): Promise<boolean> {
  if (calls <= 0) return true;
  const result = await counterStatement(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow(), calls, 0, cfBudgetGuard(calls)).all();
  return counterResult(result) !== null;
}

export async function requireCfCalls(env: Env, calls: number): Promise<void> {
  if (!(await reserveCfCalls(env, calls))) throw cfBusyError();
}

/** Cloudflare 429 的 retry-after 秒数（没有该头为 0）；不是 429 返回 null */
export function throttleSeconds(error: unknown): number | null {
  return error instanceof CloudflareApiError && error.status === 429 ? (error.retryAfter ?? 0) : null;
}

/** 设置全局退避：now + max(retryAfter, 300) 秒，只延长不缩短；写入失败只记日志 */
export async function backOffCloudflare(env: Env, retryAfterSeconds = 0): Promise<void> {
  const until = Date.now() + Math.max(retryAfterSeconds, MIN_BACKOFF_SECONDS) * 1000;
  try {
    await env.db.prepare(`INSERT INTO settings (key, value) VALUES ('cf_backoff', json_object('until', ?1))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE COALESCE(json_extract(settings.value, '$.until'), 0) < ?1`).bind(until).run();
  } catch (error) {
    console.error('写入 Cloudflare 退避标记失败:', error);
  }
}

/** 这些错误中有 429 时设置全局退避 */
export async function noteThrottle(env: Env, ...errors: unknown[]): Promise<void> {
  const seconds = errors.map(throttleSeconds).filter((value): value is number => value !== null);
  if (seconds.length) await backOffCloudflare(env, Math.max(...seconds));
}

/** 请求内读 Cloudflare 失败：429 设退避并返回 429，其余为 500（不吞成「不存在」） */
async function cfReadError(env: Env, error: unknown, what: string): Promise<AppError> {
  if (error instanceof AppError) return error;
  await noteThrottle(env, error);
  if (throttleSeconds(error) !== null) return cfBusyError();
  return new AppError('internal', `读取 Cloudflare ${what}失败：${errorText(error)}`);
}

// ---------------------------------------------------------------------------
// 账户 zone 列表（isolate 内缓存 60 秒）

const ZONE_CACHE_MS = 60_000;
const ZONE_PAGE_SIZE = 50;
const ZONE_MAX_PAGES = 10;
const ZONE_NOT_VISIBLE = 'Cloudflare 账户中没有该 zone：它可能在其他账户，或站长的 Token 无权访问';
let zoneCache: { accountId: string; at: number; page: CfPage<CfZone> } | null = null;

const zonePages = (total: number | null) => Math.min(ZONE_MAX_PAGES, Math.max(1, Math.ceil((total ?? 0) / ZONE_PAGE_SIZE)));

/** 清空本 isolate 的 zone 列表与就绪摘要缓存（测试、换凭据后使用） */
export function clearZoneCatalogCache(): void {
  zoneCache = null;
  readinessCache.clear();
}

/** 账户中 Token 可见的 zone。按上次的总数预占页数，实际页数更多时补记差额 */
export async function listCatalogZones(env: Env, creds: CloudflareCredentials, refresh = false): Promise<CfPage<CfZone>> {
  const cached = zoneCache;
  if (!refresh && cached?.accountId === creds.accountId && Date.now() - cached.at < ZONE_CACHE_MS) return cached.page;
  const estimate = zonePages(cached?.page.total ?? null);
  await requireCfCalls(env, estimate);
  let page: CfPage<CfZone>;
  try {
    page = await listAccountZones(creds, { maxPages: ZONE_MAX_PAGES });
  } catch (error) {
    throw await cfReadError(env, error, '域名列表');
  }
  const used = page.complete ? zonePages(page.total ?? page.items.length) : ZONE_MAX_PAGES;
  if (used > estimate) {
    await counterStatement(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow(), used - estimate).run()
      .catch((error) => console.error('补记 Cloudflare 调用额度失败:', error));
  }
  zoneCache = { accountId: creds.accountId, at: Date.now(), page };
  return page;
}

/** 按 zone ID 找到账户中的 zone（缓存里没有时刷新一次列表），再读一次最新状态；看不到时 404 */
export async function resolveAccountZone(env: Env, creds: CloudflareCredentials, zoneId: string): Promise<CfZone> {
  const byId = (page: CfPage<CfZone>) => page.items.find((zone) => zone.id === zoneId);
  const listed = byId(await listCatalogZones(env, creds)) ?? byId(await listCatalogZones(env, creds, true));
  if (!listed) throw new AppError('not_found', ZONE_NOT_VISIBLE);
  let zone: CfZone | null;
  try {
    zone = await getZone(creds, zoneId, listed.name);
  } catch (error) {
    throw await cfReadError(env, error, ' zone ');
  }
  if (!zone || (zone.account?.id && zone.account.id !== creds.accountId)) throw new AppError('not_found', ZONE_NOT_VISIBLE);
  return { ...zone, name: zone.name.toLowerCase() };
}

// ---------------------------------------------------------------------------
// 预检

/** D1 侧的占用与容量（一条语句）；excludeId 是正在评估的任务自身 */
export interface OccupancyFacts {
  listed: boolean;
  hosted: boolean;
  taskId: number | null;
  listedCount: number;
  activeCount: number;
  /** 等待 NS 生效的 zone：托管 pending + 系统 new_zone 进行中 */
  pendingZones: number;
  maxPending: number;
}

export async function occupancyFacts(env: Env, domain: string, excludeId = 0): Promise<OccupancyFacts> {
  const row = await env.db.prepare(`SELECT ${systemDomainListedSql('?1')} AS listed, ${hostedTakenSql('?1')} AS hosted,
      (SELECT id FROM system_domain_onboarding WHERE domain = ?1 AND state NOT IN ${ONBOARDING_TERMINAL_SQL} AND id <> ?2) AS task_id,
      ${SYSTEM_DOMAIN_COUNT_SQL} AS listed_count,
      ${ACTIVE_ONBOARDING_COUNT_SQL} - EXISTS (SELECT 1 FROM system_domain_onboarding
        WHERE id = ?2 AND state NOT IN ${ONBOARDING_TERMINAL_SQL}) AS active_count,
      (SELECT COUNT(*) FROM hosted_domains WHERE status = 'pending') + ${SYSTEM_PENDING_ZONES_SQL} AS pending_zones,
      COALESCE((SELECT json_extract(value, '$.maxPendingTotal') FROM settings WHERE key = 'hosted_domains'), ?3) AS max_pending`)
    .bind(domain, excludeId, DEFAULT_SETTINGS.hosted_domains.maxPendingTotal)
    .first<Record<'listed' | 'hosted' | 'task_id' | 'listed_count' | 'active_count' | 'pending_zones' | 'max_pending', number | null>>();
  return {
    listed: Number(row?.listed) === 1,
    hosted: Number(row?.hosted) === 1,
    taskId: row?.task_id == null ? null : Number(row.task_id),
    listedCount: Number(row?.listed_count ?? 0),
    activeCount: Number(row?.active_count ?? 0),
    pendingZones: Number(row?.pending_zones ?? 0),
    maxPending: Number(row?.max_pending ?? DEFAULT_SETTINGS.hosted_domains.maxPendingTotal),
  };
}

export function makeCheck(
  key: SystemDomainCheckKey, severity: SystemDomainSeverity, title: string, extra: Partial<SystemDomainCheck> = {},
): SystemDomainCheck {
  const state: SystemDomainCheckState = severity === 'blocker' ? 'conflict' : 'ok';
  return { key, state, severity, ack: null, danger: false, title, current: null, proposed: null, impact: '', records: [], ...extra };
}

/** 三方占用与列表容量（new_zone 另看等待 NS 的 zone 配额，与托管共用 hosted_domains.maxPendingTotal） */
export function occupancyChecks(domain: string, facts: OccupancyFacts, mode: SystemDomainOnboardingMode): SystemDomainCheck[] {
  const occupancy = !domainSchema.safeParse(domain).success
    ? makeCheck('occupancy', 'blocker', '域名格式不受本站支持，不能加为系统域名', { current: domain, impact: '本站只接受由字母、数字与连字符组成的域名' })
    : facts.listed ? makeCheck('occupancy', 'blocker', '已是系统域名', { impact: '该域名已在系统域名列表中，不需要再接入' })
      : facts.hosted ? makeCheck('occupancy', 'blocker', '已被用户托管', { impact: '用户托管的域名由其所有者管理，不能同时作为系统域名' })
        : facts.taskId !== null ? makeCheck('occupancy', 'blocker', `正在接入（任务 #${facts.taskId}）`, { impact: '同一域名同时只能有一个接入任务' })
          : makeCheck('occupancy', 'none', '未被本站占用');
  const capacity = facts.listedCount + facts.activeCount >= MAX_SYSTEM_DOMAINS
    ? makeCheck('capacity', 'blocker', `系统域名已达 ${MAX_SYSTEM_DOMAINS} 个上限（含正在接入的）`, {
      current: `${facts.listedCount} 个系统域名，${facts.activeCount} 个正在接入`, impact: '请先移除不用的系统域名或取消其他接入任务',
    })
    : mode === 'new_zone' && facts.pendingZones >= facts.maxPending
      ? makeCheck('capacity', 'blocker', `等待 NS 生效的域名已达 ${facts.maxPending} 个上限`, {
        current: `${facts.pendingZones} 个`, impact: '与用户托管域名共用这份额度，请等其他域名生效或删除后再新建 zone',
      })
      : makeCheck('capacity', 'none', '系统域名列表还有空位');
  return [occupancy, capacity];
}

function dnssecCheck(state: DnssecState): SystemDomainCheck {
  if (state === 'on') {
    return makeCheck('dnssec', 'info', '该域名开启了 DNSSEC', {
      state: 'conflict', current: '父域存在 DS 记录', impact: '改 NS 之前要先在注册商关闭 DNSSEC，否则切换后域名将无法解析',
    });
  }
  if (state === 'unknown') {
    return makeCheck('dnssec', 'info', 'DNSSEC 检测失败（不等于未开启）', {
      state: 'unknown', impact: '请在注册商确认是否开启了 DNSSEC；开启时要先关闭再改 NS',
    });
  }
  return makeCheck('dnssec', 'none', 'DNSSEC 未开启');
}

/** 需确认项（按 SYSTEM_DOMAIN_ACKS 的顺序去重） */
export const acksOf = (observed: readonly OnboardingAcceptance[]): SystemDomainAck[] =>
  SYSTEM_DOMAIN_ACKS.filter((ack) => observed.some((item) => item.ack === ack));

/** 一次预检的结果：界面用的 precheck、落库的快照，以及 apply 需要的原始读取与计划（existing_zone 且 zone 已激活时才有） */
export interface Evaluation {
  precheck: SystemDomainPrecheck;
  snapshot: OnboardingPreflightSnapshot;
  zone: CfZone | null;
  inspection: MailInspection | null;
  plan: MailPlan | null;
}

interface EvaluationParts {
  mode: SystemDomainOnboardingMode;
  domain: string;
  zone: CfZone | null;
  checks: SystemDomainCheck[];
  steps: OnboardingPreflightSnapshot['steps'];
  observed: OnboardingAcceptance[];
  fingerprint: string;
  /** 不看 D1 检查时的结论（plan 的 verdict）；有 blocker 时一律 blocked */
  verdict: SystemDomainVerdict;
  registrar: SystemDomainRegistrar | null;
  dnssec: DnssecState | null;
}

function assemble(parts: EvaluationParts, inspection: MailInspection | null, plan: MailPlan | null): Evaluation {
  const checkedAt = Date.now();
  const verdict: SystemDomainVerdict = parts.checks.some((item) => item.severity === 'blocker') ? 'blocked' : parts.verdict;
  const snapshot: OnboardingPreflightSnapshot = {
    checkedAt, fingerprint: parts.fingerprint, verdict, checks: parts.checks, steps: parts.steps, observed: parts.observed,
    registrar: parts.registrar,
  };
  const precheck: SystemDomainPrecheck = {
    mode: parts.mode,
    domain: parts.domain,
    zoneId: parts.zone?.id ?? null,
    zoneStatus: parts.zone?.status ?? null,
    checkedAt: new Date(checkedAt).toISOString(),
    checks: parts.checks,
    steps: parts.steps,
    requiredAcks: acksOf(parts.observed),
    verdict,
    fingerprint: parts.fingerprint,
    registrar: parts.registrar,
    nameServers: parts.zone?.name_servers ?? [],
    dnssec: parts.dnssec,
  };
  return { precheck, snapshot, zone: parts.zone, inspection, plan };
}

/** inspect 中读取失败的错误（用来发现 429） */
function inspectionErrors(inspection: MailInspection): unknown[] {
  return [inspection.routing, inspection.catchAll, inspection.rules, inspection.apex, inspection.dmarc, inspection.dkim,
    inspection.bounce, inspection.sending].flatMap((read) => (read && !read.ok ? [read.error] : []));
}

/**
 * 已有 zone 的预检：Cloudflare 邮件配置（mail-provisioning）+ D1 占用与容量 + 注册商（RDAP，只作提示）。
 * 调用方负责预占额度（激活的 zone 约 INSPECT_CF_CALLS 次）。registrar 传值时不再查 RDAP；
 * zone 未激活时同时检测 DNSSEC（等待 NS 阶段提示用）。
 */
export async function evaluateZone(env: Env, creds: CloudflareCredentials, zone: CfZone, domain: string, opts: {
  origin: SystemDomainZoneOrigin;
  excludeId?: number;
  facts?: OccupancyFacts;
  registrar?: SystemDomainRegistrar | null;
}): Promise<Evaluation> {
  const waiting = zone.status === 'pending' || zone.status === 'initializing';
  const [inspection, facts, registrar, dnssec] = await Promise.all([
    inspectMailConfig(creds, zone, domain),
    opts.facts ?? occupancyFacts(env, domain, opts.excludeId),
    opts.registrar !== undefined ? opts.registrar : lookupRegistrar(domain),
    waiting ? dnssecState(domain) : null,
  ]);
  await noteThrottle(env, ...inspectionErrors(inspection));
  const plan = await planMailChanges(inspection, { origin: opts.origin });
  const checks = [...occupancyChecks(domain, facts, 'existing_zone'), ...plan.checks, ...(dnssec ? [dnssecCheck(dnssec)] : [])];
  return assemble({
    mode: 'existing_zone', domain, zone, checks, steps: plan.steps, observed: plan.observed, fingerprint: plan.fingerprint,
    verdict: plan.verdict, registrar, dnssec,
  }, inspection, plan);
}

/**
 * 新建 zone 的预检：D1 占用、容量与等待 NS 的配额、账户里是否已有同名 zone（读不到时阻断，避免重复建 zone）、
 * 改 NS 的确认（ns.change，观察值为域名的哈希）、DNSSEC 三态与注册商。调用方预占 1 次调用额度。
 */
export async function evaluateNewZone(env: Env, creds: CloudflareCredentials, domain: string): Promise<Evaluation> {
  const [existing, facts, dnssec, registrar] = await Promise.all([
    findZone(creds, domain).then((zone) => ({ ok: true as const, zone }), (error: unknown) => ({ ok: false as const, error })),
    occupancyFacts(env, domain),
    dnssecState(domain),
    lookupRegistrar(domain),
  ]);
  if (!existing.ok) await noteThrottle(env, existing.error);
  const zoneCheck = !existing.ok
    ? makeCheck('zone', 'blocker', '无法确认 Cloudflare 账户中是否已有同名 zone', {
      state: 'unknown', current: errorText(existing.error), impact: '确认之前不会新建 zone，请稍后重新检测',
    })
    : existing.zone
      ? makeCheck('zone', 'blocker', '该域名已在 Cloudflare 账户中，请在可接入列表中接入', {
        current: `zone ${existing.zone.id}（${existing.zone.status}）`, impact: '已有的 zone 不会被重复创建或接管',
      })
      : makeCheck('zone', 'none', '账户中没有同名 zone，将新建 zone', { state: 'missing' });
  const observed: OnboardingAcceptance[] = [{ ack: 'ns.change', observed: await sha256Hex(domain) }];
  const checks = [
    ...occupancyChecks(domain, facts, 'new_zone'),
    zoneCheck,
    makeCheck('nameServers', 'confirm', '需要到注册商把 NS 改为 Cloudflare 分配的名称服务器', {
      state: 'missing', ack: 'ns.change', proposed: '建好 zone 后显示两条 Cloudflare NS',
      impact: '修改 NS 会影响整个域名的 DNS 解析（网站、其他邮件服务等）：请先在 Cloudflare 控制台补齐原有记录再改 NS',
    }),
    dnssecCheck(dnssec),
  ];
  return assemble({
    mode: 'new_zone', domain, zone: null, checks, steps: [], observed, fingerprint: await fingerprintOf(observed),
    verdict: 'confirm', registrar, dnssec,
  }, null, null);
}

// ---------------------------------------------------------------------------
// 隐藏列表（settings 行 system_domains：{"hiddenZones": string[], "revision": n}，不进 SETTING_SCHEMAS，直读 D1）

const HIDDEN_KEY = 'system_domains';
export const MAX_HIDDEN_ZONES = 500;

function parseHidden(value: string | null | undefined): SystemDomainHiddenZones {
  try {
    const parsed = JSON.parse(value ?? '{}') as Partial<SystemDomainHiddenZones>;
    return {
      hiddenZones: Array.isArray(parsed.hiddenZones) ? parsed.hiddenZones.filter((item): item is string => typeof item === 'string') : [],
      revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : 0,
    };
  } catch {
    return { hiddenZones: [], revision: 0 };
  }
}

export async function getHiddenZones(env: Env): Promise<SystemDomainHiddenZones> {
  const row = await env.db.prepare('SELECT value FROM settings WHERE key = ?').bind(HIDDEN_KEY).first<{ value: string }>();
  return parseHidden(row?.value);
}

/** 隐藏或恢复一个域名（revision CAS）；已是目标状态时不写入 */
export async function updateHiddenZones(
  env: Env, actor: Actor, req: UpdateSystemDomainHiddenZonesRequest, ip = '',
): Promise<SystemDomainHiddenZones> {
  const current = await getHiddenZones(env);
  if (current.revision !== req.expectedRevision) throw new AppError('conflict', '隐藏列表已被其他请求修改，请刷新后重试');
  const has = current.hiddenZones.includes(req.domain);
  if (has === req.hidden) return current;
  const hiddenZones = req.hidden ? [...current.hiddenZones, req.domain] : current.hiddenZones.filter((item) => item !== req.domain);
  if (hiddenZones.length > MAX_HIDDEN_ZONES) throw new AppError('validation_failed', `最多隐藏 ${MAX_HIDDEN_ZONES} 个域名`);
  const next = { hiddenZones, revision: current.revision + 1 };
  const written = await env.db.prepare(`INSERT INTO settings (key, value)
      SELECT ?1, ?2 WHERE ?3 = COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = ?1), 0)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE COALESCE(json_extract(settings.value, '$.revision'), 0) = ?3 RETURNING key`)
    .bind(HIDDEN_KEY, JSON.stringify(next), current.revision).first();
  if (!written) throw new AppError('conflict', '隐藏列表已被其他请求修改，请刷新后重试');
  await logAdminAction(env, actor, req.hidden ? 'system_domain.hide' : 'system_domain.unhide', req.domain, '', ip);
  return next;
}

// ---------------------------------------------------------------------------
// zone 分类与就绪摘要

const READINESS_CACHE_MS = 60_000;
/** 每次请求最多预检的 available zone 数；其余标为 unchecked，点击时再查 */
const READINESS_PER_REQUEST = 10;
const READINESS_CONCURRENCY = 3;
const readinessCache = new Map<string, { at: number; value: SystemDomainZoneReadiness }>();

const unchecked = (): SystemDomainZoneReadiness => ({ verdict: 'unchecked', confirmCount: 0, reasons: [], registrar: null, checkedAt: null });

function readinessOf(precheck: SystemDomainPrecheck): SystemDomainZoneReadiness {
  const pick = (severity: SystemDomainSeverity) => precheck.checks.filter((item) => item.severity === severity).map((item) => item.title);
  const reasons = [...pick('blocker'), ...pick('confirm'),
    ...(precheck.verdict === 'pending' ? precheck.checks.filter((item) => item.key === 'zone').map((item) => item.title) : [])];
  return {
    verdict: precheck.verdict, confirmCount: precheck.requiredAcks.length, reasons: reasons.slice(0, 5),
    registrar: precheck.registrar, checkedAt: precheck.checkedAt,
  };
}

/** 为未缓存的 available zone 逐批预检（含 RDAP），每个先预占额度；额度不足时其余保持 unchecked，不报错 */
async function fillReadiness(env: Env, creds: CloudflareCredentials, zones: CfZone[], facts: OccupancyFacts): Promise<void> {
  const now = Date.now();
  const due = zones.filter((zone) => (readinessCache.get(zone.id)?.at ?? 0) <= now - READINESS_CACHE_MS).slice(0, READINESS_PER_REQUEST);
  let exhausted = false;
  for (let i = 0; i < due.length && !exhausted; i += READINESS_CONCURRENCY) {
    await Promise.all(due.slice(i, i + READINESS_CONCURRENCY).map(async (zone) => {
      // 未激活的 zone 只读 zone 本身（列表里已有），不调用 Cloudflare
      if (exhausted || !(await reserveCfCalls(env, zone.status === 'active' ? INSPECT_CF_CALLS : 0))) {
        exhausted = true;
        return;
      }
      try {
        const { precheck } = await evaluateZone(env, creds, zone, zone.name, { origin: 'linked', facts });
        readinessCache.set(zone.id, { at: Date.now(), value: readinessOf(precheck) });
      } catch (error) {
        console.error(`预检 zone ${zone.name} 失败:`, error);
      }
    }));
  }
}

const zeroCounts = (): SystemDomainZonesView['counts'] => ({
  ...Object.fromEntries(SYSTEM_DOMAIN_ZONE_CATEGORIES.map((category) => [category, 0])) as Record<SystemDomainZoneCategory, number>,
  hostedByAdmin: 0, hidden: 0,
});

/**
 * 可接入列表：Cloudflare zone 列表 + D1（系统列表、hosted_domains JOIN users、进行中的任务、隐藏列表）逐个分类，
 * available 且未隐藏的 zone 附就绪摘要。summarize 把任务行转成列表行内的摘要（由 system-domain.ts 提供）。
 */
export async function zonesView(
  env: Env, query: SystemDomainZonesQuery, summarize: (row: OnboardingRow) => SystemDomainOnboardingSummary,
): Promise<SystemDomainZonesView> {
  const creds = cloudflareCredentials(env);
  if (!creds) {
    return { configured: false, zones: [], others: [], unlistedTasks: [], counts: zeroCounts(), complete: true, hiddenRevision: 0 };
  }
  const page = await listCatalogZones(env, creds, query.refresh);
  const db = createDb(env);
  const [settingRows, hostedRows, tasks] = await db.batch([
    db.select().from(settings).where(inArray(settings.key, ['domains', HIDDEN_KEY])),
    db.select({ domain: hostedDomains.domain, zoneId: hostedDomains.zoneId, userId: hostedDomains.userId, username: users.username, role: users.role })
      .from(hostedDomains).leftJoin(users, eq(users.id, hostedDomains.userId)),
    db.select().from(systemDomainOnboarding).where(sql`${systemDomainOnboarding.state} NOT IN ${sql.raw(ONBOARDING_TERMINAL_SQL)}`),
  ]);
  const systemList = new Set(mergeSettingRows(settingRows).domains.list.map((entry) => entry.domain));
  const hidden = parseHidden(settingRows.find((row) => row.key === HIDDEN_KEY)?.value);
  const hiddenSet = new Set(hidden.hiddenZones);
  const hostedByDomain = new Map(hostedRows.map((row) => [row.domain, row]));
  const taskByDomain = new Map(tasks.map((task) => [task.domain, task]));

  const counts = zeroCounts();
  const zones: SystemDomainZone[] = [];
  const others: SystemDomainZone[] = [];
  const available: CfZone[] = [];
  const listedNames = new Set<string>();
  for (const zone of page.items) {
    const name = zone.name.toLowerCase();
    listedNames.add(name);
    const hostedRow = hostedByDomain.get(name);
    const task = taskByDomain.get(name);
    const category: SystemDomainZoneCategory = systemList.has(name) ? 'system'
      : hostedRow ? (hostedRow.zoneId === zone.id ? 'hosted' : 'inconsistent')
        : task ? 'onboarding' : 'available';
    const isHidden = hiddenSet.has(name);
    const owner = hostedRow && category !== 'system'
      ? { userId: hostedRow.userId, username: hostedRow.username ?? `user#${hostedRow.userId}`, isAdmin: hostedRow.role === 'admin' }
      : null;
    counts[category] += 1;
    if (owner?.isAdmin && category === 'hosted') counts.hostedByAdmin += 1;
    if (isHidden && category === 'available') counts.hidden += 1;
    const item: SystemDomainZone = {
      zoneId: zone.id, name, status: zone.status, type: zone.type ?? null, paused: zone.paused ?? false, category, hidden: isHidden,
      owner, onboarding: category === 'onboarding' && task ? summarize(task) : null, readiness: null,
    };
    if (category === 'available') {
      if (isHidden !== query.hidden) continue;
      zones.push(item);
      if (!isHidden) available.push(zone);
    } else if (category === 'onboarding') {
      if (!query.hidden) zones.push(item);
    } else others.push(item);
  }

  if (available.length) {
    await fillReadiness(env, creds, available, {
      listed: false, hosted: false, taskId: null, listedCount: systemList.size, activeCount: tasks.length, pendingZones: 0,
      maxPending: Number.POSITIVE_INFINITY,
    });
  }
  for (const item of zones) {
    if (item.category === 'available') item.readiness = readinessCache.get(item.zoneId)?.value ?? unchecked();
  }
  return {
    configured: true,
    zones,
    others,
    unlistedTasks: tasks.filter((task) => !listedNames.has(task.domain)).map(summarize),
    counts,
    complete: page.complete,
    hiddenRevision: hidden.revision,
  };
}
