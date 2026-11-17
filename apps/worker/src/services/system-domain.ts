/**
 * 系统域名一键接入的编排：任务表状态机、租约、完成时写入系统域名列表、取消，以及定时任务。
 *
 * - 三方同名互斥（系统列表、hosted_domains、进行中的任务）写在占位 INSERT 与完成时的 CAS 里（domain-occupancy.ts）。
 * - 后台处理器（API 的 waitUntil、手动检测、cron）靠租约排他：每次获取生成新 token，所有状态写回带 `lease_token = ?`，
 *   过期的处理器写不进去；台账（changes）只追加、不受租约约束，已经发生的远端写入一定记下。
 * - 取消只置标记，处理器在检查点执行。deleteZone 只有一个调用点：本任务创建、从未激活、取消时勾选删除且 zone 仍未激活。
 * - Cloudflare 邮件配置的读写在 mail-provisioning.ts；预检、zone 分类、调用额度与退避在 zone-catalog.ts。
 */
import {
  DEFAULT_SETTINGS, SETTING_SCHEMAS, SYSTEM_DOMAIN_ONBOARDING_TERMINAL_STATES,
  type DomainEntry, type SystemDomainAck, type SystemDomainChange, type SystemDomainOnboarding, type SystemDomainOnboardingMode,
  type SystemDomainOnboardingsQuery, type SystemDomainOnboardingState, type SystemDomainOnboardingSummary, type SystemDomainPrecheck,
  type SystemDomainStep, type SystemDomainStepKey, type SystemDomainStepState, type SystemDomainZonesQuery, type SystemDomainZonesView,
  type SystemDomainZoneOrigin,
} from '@hpc-mail/shared';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { systemDomainOnboarding, users, type OnboardingAcceptance, type OnboardingChangeEvent } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import { logAdminAction } from './audit.js';
import {
  CloudflareApiError, cloudflareCredentials, createZone, deleteZone, findZone, getZone, isOutcomeUnknown, isTransientCloudflareError,
  requestActivationCheck, type CfZone, type CloudflareCredentials,
} from './cloudflare.js';
import {
  ACTIVE_ONBOARDING_COUNT_SQL, hostedTakenSql, onboardingActiveSql, ONBOARDING_TERMINAL_SQL, SYSTEM_DOMAIN_COUNT_SQL,
  SYSTEM_PENDING_ZONES_SQL, systemDomainListedSql,
} from './domain-occupancy.js';
import {
  APPLY_CF_CALLS, applyMailPlan, dnssecState, gatePlan, INSPECT_CF_CALLS, type ApplyHooks, type MailStepSnapshot,
} from './mail-provisioning.js';
import { counterStatement } from './rate-counter.js';
import { domainsCasSql, invalidateSettingsMemory } from './setting.js';
import {
  acksOf, backOffCloudflare, cfBudgetGuard, cfBusyError, cfWindow, errorText, evaluateNewZone, evaluateZone, MAX_SYSTEM_DOMAINS,
  noteThrottle, occupancyChecks, occupancyFacts, requireCfCalls, requireCredentials, reserveCfCalls, resolveAccountZone,
  SYSTEM_DOMAIN_CF_SCOPE, zonesView, type Evaluation,
} from './zone-catalog.js';

type OnboardingRow = typeof systemDomainOnboarding.$inferSelect;
type OnboardingFields = Partial<typeof systemDomainOnboarding.$inferInsert>;
type Actor = Pick<AuthUser, 'id' | 'username'>;

const MINUTE = 60_000;
/** 租约 2 分钟：两次心跳之间最长是一段只读预检 */
const LEASE_MS = 2 * MINUTE;
/** 手动检测的最短间隔 */
const CHECK_THROTTLE_MS = 15_000;
/** 建 zone 的请求结果不明时，过这么久再按名称确认 */
const RESERVATION_STALE_MS = 10 * MINUTE;
/** 进入配置后这段时间内仍未全部就绪：blocked(provision_timeout)，之后每 30 分钟只读复检 */
const PROVISION_GRACE_MS = 30 * MINUTE;
const AWAITING_NS_RECHECK_MS = 10 * MINUTE;
const BLOCKED_RECHECK_MS = 30 * MINUTE;
/** 第三方 MX 已删、路由没开起来：这个域名暂时收不了信，按最短间隔重试 */
const MX_PENDING_RECHECK_MS = 5 * MINUTE;
const MAX_RETRY_DELAY_MS = 2 * 60 * MINUTE;
/** 请求内与 waitUntil 中一次处理的墙钟上限 */
const API_DEADLINE_MS = 20_000;
/** 定时任务每轮最多处理的任务数与墙钟上限 */
export const CRON_ONBOARDING_LIMIT = 3;
const CRON_DEADLINE_MS = 20_000;
/** 一次处理内最多推进的步数（等待 NS → 预检 → 配置 → 完成） */
const MAX_STEPS = 8;
const MAX_CHANGES = 200;
const FINALIZE_ATTEMPTS = 3;
/** 新条目与前端手动添加一致：仅管理员可认领、不限每人数量、参与随机 */
const DEFAULT_ENTRY = { public: false, perUserLimit: 0, random: true };
const SYSTEM_ACTOR = { id: 0, username: 'system' };

const TERMINAL: readonly SystemDomainOnboardingState[] = SYSTEM_DOMAIN_ONBOARDING_TERMINAL_STATES;
const isTerminal = (state: SystemDomainOnboardingState) => TERMINAL.includes(state);
const isWaiting = (zone: CfZone) => zone.status === 'pending' || zone.status === 'initializing';
const retryDelay = (attempts: number) => Math.min(5 * MINUTE * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_DELAY_MS);
const later = (ms: number) => new Date(Date.now() + ms);

const ZONE_MISSING = 'Cloudflare 中的 zone 已不存在';
const STALE_FINGERPRINT = 'Cloudflare 上的配置已变化，请重新核对后确认';
const CANCEL_KEEPS = '如需停用请在系统域名列表中移除';

/** 后台任务：有 ctx 放进 waitUntil，没有时（单测）同步等待 */
async function runDetached(ctx: ExecCtx | null | undefined, task: () => Promise<unknown>): Promise<void> {
  const guarded = task().catch((error) => console.error('系统域名接入后台处理失败:', error));
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}

// ---------------------------------------------------------------------------
// 视图

const COLUMNS = getTableColumns(systemDomainOnboarding);

/** RETURNING * 的原始行（列名为 snake_case）转成 Drizzle 行 */
function rowFromRaw(raw: Record<string, unknown>): OnboardingRow {
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = raw[column.name];
    row[key] = value === null || value === undefined ? null : (column as { mapFromDriverValue(v: unknown): unknown }).mapFromDriverValue(value);
  }
  return row as OnboardingRow;
}

const STEP_LABEL: Record<Exclude<SystemDomainStepKey, 'zone'>, string> = { routing: '收件路由', catchAll: '全部地址投递到本站', sending: '发信' };
const STEP_STATE_TEXT: Record<SystemDomainStepState, string> = {
  unknown: '尚未检测或读取失败', waiting: '等待 zone 生效', missing: '待配置', ready: '已就绪', conflict: '存在冲突，见预检结果', error: '写入失败',
};

function zoneStep(row: OnboardingRow): SystemDomainStep {
  switch (row.zoneStatus) {
    case 'active': return { state: 'ready', detail: 'Cloudflare zone 已生效' };
    case 'pending':
    case 'initializing': return { state: 'waiting', detail: '等待 NS 生效' };
    case 'missing': return { state: 'error', detail: ZONE_MISSING };
    case 'moved': return { state: 'error', detail: '域名的 NS 已不再指向 Cloudflare' };
    default: return { state: 'unknown', detail: row.zoneId ? '尚未检测' : '正在创建 zone' };
  }
}

const step = (key: Exclude<SystemDomainStepKey, 'zone'>, state: SystemDomainStepState): SystemDomainStep =>
  ({ state, detail: `${STEP_LABEL[key]}：${STEP_STATE_TEXT[state]}` });

function precheckOf(row: OnboardingRow): SystemDomainPrecheck | null {
  const snapshot = row.preflight;
  if (!snapshot) return null;
  return {
    mode: row.mode, domain: row.domain, zoneId: row.zoneId, zoneStatus: row.zoneStatus || null,
    checkedAt: new Date(snapshot.checkedAt).toISOString(), checks: snapshot.checks, steps: snapshot.steps,
    requiredAcks: acksOf(snapshot.observed), verdict: snapshot.verdict, fingerprint: snapshot.fingerprint, registrar: snapshot.registrar,
    nameServers: row.nameServers, dnssec: row.mode === 'new_zone' || row.zoneStatus !== 'active' ? row.dnssec : null,
  };
}

function changeOf(event: OnboardingChangeEvent): SystemDomainChange {
  return {
    seq: event.seq, kind: event.kind, status: event.status, at: new Date(event.at).toISOString(), target: event.target ?? null,
    before: event.before === undefined || event.before === null ? null
      : typeof event.before === 'string' ? event.before : JSON.stringify(event.before),
    error: event.error ?? null,
  };
}

const canDeleteZone = (row: OnboardingRow) => row.zoneOrigin === 'created' && row.activatedAt === null && !isTerminal(row.state);
const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toView(row: OnboardingRow, createdBy: string | null): SystemDomainOnboarding {
  return {
    id: row.id,
    domain: row.domain,
    mode: row.mode,
    state: row.state,
    zoneId: row.zoneId,
    zoneOrigin: row.zoneOrigin,
    zoneStatus: row.zoneStatus,
    nameServers: row.nameServers,
    originalNameServers: row.originalNameServers,
    originalRegistrar: row.originalRegistrar,
    dnssec: row.dnssec,
    steps: {
      zone: zoneStep(row), routing: step('routing', row.routingState), catchAll: step('catchAll', row.catchAllState),
      sending: step('sending', row.sendingState),
    },
    precheck: precheckOf(row),
    accepted: acksOf(row.accepted),
    changes: row.changes.map(changeOf),
    errorCode: row.errorCode,
    lastError: row.lastError,
    cancelRequested: row.cancelRequestedAt !== null,
    canDeleteZone: canDeleteZone(row),
    createdBy: createdBy ?? `user#${row.createdBy}`,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stateChangedAt: row.stateChangedAt.toISOString(),
    checkedAt: iso(row.checkedAt),
    nextCheckAt: iso(row.nextCheckAt),
    activatedAt: iso(row.activatedAt),
    finishedAt: iso(row.finishedAt),
    dashboardUrl: row.zoneId ? `https://dash.cloudflare.com/${row.accountId}/${row.domain}` : null,
  };
}

/** 列表行内的摘要（zone 列表与未列出的任务） */
export function summaryOf(row: OnboardingRow): SystemDomainOnboardingSummary {
  const view = toView(row, null);
  return {
    id: view.id, domain: view.domain, mode: view.mode, state: view.state, steps: view.steps, errorCode: view.errorCode,
    lastError: view.lastError, updatedAt: view.updatedAt, nextCheckAt: view.nextCheckAt, cancelRequested: view.cancelRequested,
  };
}

const activeSql = sql`${systemDomainOnboarding.state} NOT IN ${sql.raw(ONBOARDING_TERMINAL_SQL)}`;

function viewQuery(env: Env) {
  return createDb(env).select({ row: systemDomainOnboarding, createdBy: users.username }).from(systemDomainOnboarding)
    .leftJoin(users, eq(users.id, systemDomainOnboarding.createdBy));
}

export async function listOnboardings(env: Env, query: SystemDomainOnboardingsQuery): Promise<SystemDomainOnboarding[]> {
  const rows = await viewQuery(env).where(query.active ? activeSql : undefined)
    .orderBy(desc(systemDomainOnboarding.id)).limit(query.limit).all();
  return rows.map((item) => toView(item.row, item.createdBy));
}

export async function getOnboarding(env: Env, id: number): Promise<SystemDomainOnboarding> {
  const found = await viewQuery(env).where(eq(systemDomainOnboarding.id, id)).get();
  if (!found) throw new AppError('not_found', '接入任务不存在');
  return toView(found.row, found.createdBy);
}

async function loadRow(env: Env, id: number): Promise<OnboardingRow> {
  const row = await createDb(env).select().from(systemDomainOnboarding).where(eq(systemDomainOnboarding.id, id)).get();
  if (!row) throw new AppError('not_found', '接入任务不存在');
  return row;
}

/** GET /zones：可接入列表 */
export function systemDomainZones(env: Env, query: SystemDomainZonesQuery): Promise<SystemDomainZonesView> {
  return zonesView(env, query, summaryOf);
}

/** GET /precheck：只读完整预检；业务冲突不报错，放在 checks 里 */
export async function precheckSystemDomain(
  env: Env, query: { mode: 'new_zone'; domain: string } | { mode: 'existing_zone'; zoneId: string },
): Promise<SystemDomainPrecheck> {
  const creds = requireCredentials(env);
  if (query.mode === 'new_zone') {
    await requireCfCalls(env, 1);
    return (await evaluateNewZone(env, creds, query.domain)).precheck;
  }
  return (await existingEvaluation(env, creds, query.zoneId)).precheck;
}

/** existing_zone：按 ID 找到 zone、预占额度并预检 */
async function existingEvaluation(env: Env, creds: CloudflareCredentials, zoneId: string): Promise<Evaluation> {
  // 读最新 zone 1 次 + 只读预检
  await requireCfCalls(env, 1 + INSPECT_CF_CALLS);
  const zone = await resolveAccountZone(env, creds, zoneId);
  return evaluateZone(env, creds, zone, zone.name, { origin: 'linked' });
}

// ---------------------------------------------------------------------------
// 租约与处理上下文

/** 预占调用额度时按状态估算（转入下一阶段时再按需补占） */
function callsFor(state: SystemDomainOnboardingState, manual = false): number {
  switch (state) {
    case 'creating_zone': return 1;
    case 'awaiting_ns': return manual ? 2 : 1;
    case 'cancelling': return 2;
    case 'finalizing': return 0;
    case 'configuring': return 1 + INSPECT_CF_CALLS + APPLY_CF_CALLS;
    default: return 1 + INSPECT_CF_CALLS;
  }
}

interface Lease {
  row: OnboardingRow;
  token: string;
  /** 获取租约时一并预占的调用额度 */
  pool: number;
}

/**
 * 原子获取租约：cron 要求到期（next_check_at），manual 要求距上次核对超过 15 秒（并记下核对时间），force 用于确认与取消。
 * 同一个 batch 内按估算预占调用额度：额度不够或在 429 退避期内时不取租约。overBudget 表示「本可以取到租约，只是额度不够」。
 */
async function acquireLease(env: Env, id: number, mode: 'cron' | 'manual' | 'force', calls: number): Promise<{ lease: Lease | null; overBudget: boolean }> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const budget = cfBudgetGuard(calls, now);
  const eligible = `state NOT IN ${ONBOARDING_TERMINAL_SQL} AND (lease_until IS NULL OR lease_until < ?)
    AND (CASE ? WHEN 'force' THEN 1 WHEN 'manual' THEN COALESCE(checked_at, 0) <= ?
      ELSE next_check_at IS NOT NULL AND next_check_at <= ? END)`;
  const eligibleParams = [now, mode, now - CHECK_THROTTLE_MS, now];
  const [probe, acquired] = await env.db.batch([
    env.db.prepare(`SELECT (${eligible}) AS eligible, NOT (${budget.sql}) AS over FROM system_domain_onboarding WHERE id = ?`)
      .bind(...eligibleParams, ...budget.params, id),
    env.db.prepare(`UPDATE system_domain_onboarding SET lease_token = ?, lease_until = ?,
        checked_at = CASE WHEN ? = 'manual' THEN ? ELSE checked_at END
      WHERE id = ? AND ${eligible} AND (? = 0 OR (${budget.sql})) RETURNING *`)
      .bind(token, now + LEASE_MS, mode, now, id, ...eligibleParams, calls, ...budget.params),
    counterStatement(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow(now), calls, 0, {
      sql: '? > 0 AND EXISTS (SELECT 1 FROM system_domain_onboarding WHERE id = ? AND lease_token = ?)', params: [calls, id, token],
    }),
  ]);
  const raw = acquired?.results?.[0] as Record<string, unknown> | undefined;
  if (raw) return { lease: { row: rowFromRaw(raw), token, pool: calls }, overBudget: false };
  const flags = probe?.results?.[0] as { eligible: number; over: number } | undefined;
  return { lease: null, overBudget: calls > 0 && Number(flags?.eligible) === 1 && Number(flags?.over) === 1 };
}

/** 一次处理：持有租约，row 为最近一次写回后的行 */
interface Run {
  env: Env;
  creds: CloudflareCredentials | null;
  id: number;
  token: string;
  row: OnboardingRow;
  deadline: number;
  /** 本次已预占、还没用掉的调用额度 */
  pool: number;
  /** 台账中已分配的最大 seq */
  seq: number;
  activationCheck: boolean;
  /** 请求内刚做完的预检（创建、确认），处理时直接使用，不重复读取 */
  prepared?: Evaluation;
  /** 写入前的心跳发现已请求取消 */
  cancelSeen: boolean;
}

function newRun(env: Env, creds: CloudflareCredentials | null, lease: Lease, opts: {
  deadline?: number; activationCheck?: boolean; prepared?: Evaluation;
} = {}): Run {
  return {
    env, creds, id: lease.row.id, token: lease.token, row: lease.row, deadline: opts.deadline ?? Date.now() + API_DEADLINE_MS,
    pool: lease.pool, seq: lease.row.changes.reduce((max, event) => Math.max(max, event.seq), 0),
    activationCheck: opts.activationCheck ?? false, prepared: opts.prepared, cancelSeen: false,
  };
}

/** 本次处理的调用额度用完：保存进度，交给下一轮 */
class BudgetExhausted extends Error {}

/** 从预占中扣除；不够时补占，补不到则停止本次处理 */
async function spend(run: Run, calls: number): Promise<void> {
  if (run.pool >= calls) {
    run.pool -= calls;
    return;
  }
  const need = calls - run.pool;
  run.pool = 0;
  if (!(await reserveCfCalls(run.env, need))) throw new BudgetExhausted();
}

const credsOf = (run: Run): CloudflareCredentials => {
  if (!run.creds) throw new Error('缺少 Cloudflare 凭据');
  return run.creds;
};

/**
 * 带租约写回（fencing）：keep=true 续租继续处理，否则释放租约。租约已丢失时返回 false，调用方必须停止。
 * 状态变化时一并更新 state_changed_at。
 */
async function save(run: Run, fields: OnboardingFields, keep = false): Promise<boolean> {
  const now = new Date();
  const row = await createDb(run.env).update(systemDomainOnboarding).set({
    ...fields,
    updatedAt: now,
    ...(fields.state && fields.state !== run.row.state ? { stateChangedAt: now } : {}),
    ...(keep ? { leaseUntil: new Date(now.getTime() + LEASE_MS) } : { leaseToken: null, leaseUntil: null }),
  }).where(and(eq(systemDomainOnboarding.id, run.id), eq(systemDomainOnboarding.leaseToken, run.token))).returning().get();
  if (!row) return false;
  run.row = row;
  return true;
}

/** 追加台账事件（不受租约约束；最多 200 条） */
async function appendChange(env: Env, id: number, event: OnboardingChangeEvent): Promise<void> {
  await env.db.prepare(`UPDATE system_domain_onboarding SET changes = json_insert(changes, '$[#]', json(?1)), updated_at = ?2
    WHERE id = ?3 AND json_array_length(changes) < ?4`).bind(JSON.stringify(event), Date.now(), id, MAX_CHANGES).run();
}

async function record(run: Run, event: Omit<OnboardingChangeEvent, 'seq' | 'at'> & { seq?: number }): Promise<number> {
  const seq = event.seq ?? ++run.seq;
  await appendChange(run.env, run.id, { ...event, seq, at: Date.now() });
  return seq;
}

const zoneFields = (zone: CfZone): OnboardingFields => ({
  zoneId: zone.id, zoneStatus: zone.status, nameServers: zone.name_servers ?? [],
  originalNameServers: zone.original_name_servers ?? [], originalRegistrar: zone.original_registrar ?? '',
});

const stepFields = (snapshot: MailStepSnapshot | null | undefined): OnboardingFields => (snapshot ? {
  routingState: snapshot.routing.state, routingStatus: snapshot.routing.status, catchAllState: snapshot.catchAll.state,
  sendingState: snapshot.sending.state, sendingStatus: snapshot.sending.status, sendingTag: snapshot.sending.tag,
} : {});

type Step = 'continue' | 'stop';

/** 进入 failed（终态），审计 system_domain.fail */
async function fail(run: Run, code: string, message: string, extra: OnboardingFields = {}): Promise<Step> {
  if (await save(run, { ...extra, state: 'failed', errorCode: code, lastError: message, finishedAt: new Date(), nextCheckAt: null })) {
    await logAdminAction(run.env, SYSTEM_ACTOR, 'system_domain.fail', run.row.domain, `任务 #${run.id}：${message}`);
  }
  return 'stop';
}

// ---------------------------------------------------------------------------
// 状态机

/** 持有租约推进，直到需要等待；瞬时错误按退避重试。AppError（确认的校验结果）在释放租约后原样抛出 */
async function drive(run: Run): Promise<void> {
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if ((await advance(run)) === 'stop') return;
    }
    await save(run, { nextCheckAt: new Date() });
  } catch (error) {
    if (error instanceof AppError) {
      await save(run, {});
      throw error;
    }
    if (error instanceof BudgetExhausted) {
      await save(run, { nextCheckAt: new Date() });
      return;
    }
    console.error(`系统域名接入任务 #${run.id} 处理失败:`, error);
    await noteThrottle(run.env, error);
    const attempts = run.row.attempts + 1;
    await save(run, {
      attempts,
      errorCode: error instanceof CloudflareApiError ? (isTransientCloudflareError(error) ? 'cf_transient' : 'cf_error') : 'internal',
      lastError: `${error instanceof CloudflareApiError ? 'Cloudflare 操作失败' : '处理失败'}：${errorText(error)}`,
      nextCheckAt: later(retryDelay(attempts)),
    });
  }
}

async function advance(run: Run): Promise<Step> {
  const { row } = run;
  if (isTerminal(row.state)) return 'stop';
  if (row.cancelRequestedAt) return stepCancel(run);
  if (!run.creds) {
    await save(run, {});
    return 'stop';
  }
  // 凭据换了账户：不再调用 Cloudflare
  if (row.accountId !== run.creds.accountId) {
    await save(run, {
      state: 'blocked', errorCode: 'account_mismatch', lastError: 'Cloudflare 凭据已换成其他账户，本任务无法继续，请取消后重新接入',
      nextCheckAt: later(BLOCKED_RECHECK_MS),
    });
    return 'stop';
  }
  switch (row.state) {
    case 'creating_zone': return stepCreatingZone(run);
    case 'awaiting_ns': return stepAwaitingNs(run);
    case 'finalizing': return finalize(run);
    default: return evaluate(run);
  }
}

const adoptable = (zone: CfZone, row: OnboardingRow) =>
  Boolean(zone.created_on && new Date(zone.created_on).getTime() >= row.createdAt.getTime() - MINUTE);

/** 建 zone 的结果不明：占位 10 分钟后按名称找回。只采纳占位之后创建的 zone，来源保持 unknown（永不删除） */
async function stepCreatingZone(run: Run): Promise<Step> {
  const { row } = run;
  const due = row.createdAt.getTime() + RESERVATION_STALE_MS;
  if (Date.now() < due) {
    await save(run, { nextCheckAt: new Date(due) });
    return 'stop';
  }
  await spend(run, 1);
  const zone = await findZone(credsOf(run), row.domain);
  if (!zone) return fail(run, 'create_failed', 'Cloudflare 没有建成该 zone，请重新接入');
  if (!adoptable(zone, row)) {
    return fail(run, 'zone_replaced', 'Cloudflare 账户中的同名 zone 不是本任务创建的，请在可接入列表中改用已有 zone 接入');
  }
  await record(run, { seq: 1, kind: 'zone.create', status: 'done', target: zone.id, error: '请求结果不明，按名称找回（来源未确认，永不删除）' });
  const ok = await save(run, { ...zoneFields(zone), state: 'awaiting_ns', errorCode: '', lastError: '', attempts: 0 }, true);
  return ok ? 'continue' : 'stop';
}

/** 等待 NS：未激活时刷新 NS 与 DNSSEC（手动检测时请 Cloudflare 立即复查），激活后同轮进入预检 */
async function stepAwaitingNs(run: Run): Promise<Step> {
  const { row } = run;
  const creds = credsOf(run);
  await spend(run, run.activationCheck ? 2 : 1);
  const zone = await getZone(creds, row.zoneId!, row.domain);
  if (!zone) return fail(run, 'zone_missing', ZONE_MISSING, { zoneStatus: 'missing' });
  if (isWaiting(zone)) {
    if (run.activationCheck) await requestActivationCheck(creds, zone.id);
    const dnssec = await dnssecState(row.domain);
    await save(run, { ...zoneFields(zone), dnssec, errorCode: '', lastError: '', attempts: 0, nextCheckAt: later(AWAITING_NS_RECHECK_MS) });
    return 'stop';
  }
  const activatedAt = zone.status === 'active'
    ? row.activatedAt ?? (zone.activated_on ? new Date(zone.activated_on) : new Date()) : row.activatedAt;
  if (!(await save(run, { ...zoneFields(zone), activatedAt }, true))) return 'stop';
  return evaluate(run, zone);
}

/** 读取最新 zone 并预检；zone 不存在进入 failed，退回未激活时回到等待 NS。返回 null 表示已写回并释放租约 */
async function inspectFresh(run: Run, known?: CfZone): Promise<Evaluation | null> {
  const { row } = run;
  const creds = credsOf(run);
  let zone = known;
  if (!zone) {
    await spend(run, 1);
    zone = (await getZone(creds, row.zoneId!, row.domain)) ?? undefined;
    if (!zone) {
      await fail(run, 'zone_missing', ZONE_MISSING, { zoneStatus: 'missing' });
      return null;
    }
  }
  if (isWaiting(zone)) {
    await save(run, { ...zoneFields(zone), state: 'awaiting_ns', nextCheckAt: later(AWAITING_NS_RECHECK_MS) });
    return null;
  }
  await spend(run, zone.status === 'active' ? INSPECT_CF_CALLS : 0);
  return evaluateZone(run.env, creds, zone, row.domain, {
    origin: row.zoneOrigin, excludeId: row.id, registrar: row.preflight?.registrar ?? null,
  });
}

/** 预检结果的公共写回字段 */
const evaluationFields = (ev: Evaluation, row: OnboardingRow): OnboardingFields => ({
  preflight: ev.snapshot, zoneStatus: ev.zone?.status ?? row.zoneStatus, checkedAt: new Date(), ...stepFields(ev.plan?.snapshot),
});

const BLOCKER_CODES: Partial<Record<string, string>> = { occupancy: 'occupied', capacity: 'list_full', token: 'cf_auth' };

/** 写前门禁的结论写回：blocked / needs_confirmation 释放租约；finalizing / configuring 续租 */
async function decide(run: Run, ev: Evaluation): Promise<SystemDomainOnboardingState | null> {
  const { row } = run;
  const gate = gatePlan({ checks: ev.precheck.checks, observed: ev.snapshot.observed }, row.accepted);
  const base = evaluationFields(ev, row);
  const blocker = gate.blockers[0];
  if (blocker) {
    await save(run, {
      ...base, state: 'blocked', attempts: 0, lastError: blocker.title, nextCheckAt: later(BLOCKED_RECHECK_MS),
      errorCode: BLOCKER_CODES[blocker.key] ?? (blocker.state === 'unknown' ? 'read_failed' : `${blocker.key}_conflict`),
    });
    return null;
  }
  if (gate.unconfirmed.length) {
    await save(run, {
      ...base, state: 'needs_confirmation', attempts: 0, errorCode: 'needs_confirmation',
      lastError: `需要确认 ${gate.unconfirmed.length} 项变更`, nextCheckAt: null,
    });
    return null;
  }
  const state = ev.plan?.ready ? 'finalizing' : 'configuring';
  const ok = await save(run, { ...base, state, errorCode: '', lastError: '' }, true);
  return ok ? state : null;
}

/** blocked / needs_confirmation / configuring：重新预检、门禁，然后写入或完成 */
async function evaluate(run: Run, known?: CfZone): Promise<Step> {
  const ev = run.prepared ?? (await inspectFresh(run, known));
  run.prepared = undefined;
  if (!ev) return 'stop';
  const state = await decide(run, ev);
  if (state === 'finalizing') return finalize(run);
  if (state === 'configuring') return apply(run, ev);
  return 'stop';
}

function applyHooks(run: Run): ApplyHooks {
  return {
    // 心跳 + 取消检查：续租；租约丢失或已请求取消时不再写入
    beforeWrite: async () => {
      const beat = await run.env.db.prepare(`UPDATE system_domain_onboarding SET lease_until = ?1
        WHERE id = ?2 AND lease_token = ?3 RETURNING cancel_requested_at`).bind(Date.now() + LEASE_MS, run.id, run.token)
        .first<{ cancel_requested_at: number | null }>();
      if (!beat) return false;
      if (beat.cancel_requested_at !== null) {
        run.cancelSeen = true;
        return false;
      }
      return true;
    },
    record: (event) => record(run, event),
    deadline: run.deadline,
  };
}

/** configuring：按计划写入，结果映射为下一状态 */
async function apply(run: Run, ev: Evaluation): Promise<Step> {
  await spend(run, APPLY_CF_CALLS);
  const result = await applyMailPlan(credsOf(run), ev.inspection!, ev.plan!, applyHooks(run));
  if (result.retryAfter !== undefined) await backOffCloudflare(run.env, result.retryAfter);
  const fields = stepFields(result.snapshot);
  switch (result.outcome) {
    case 'ready':
      return (await save(run, { ...fields, state: 'finalizing', errorCode: '', lastError: '', attempts: 0 }, true)) ? finalize(run) : 'stop';
    case 'progress':
      if (Date.now() - run.row.stateChangedAt.getTime() > PROVISION_GRACE_MS) {
        await save(run, {
          ...fields, state: 'blocked', errorCode: 'provision_timeout', attempts: 0, nextCheckAt: later(BLOCKED_RECHECK_MS),
          lastError: `配置超过 30 分钟仍未全部就绪${result.error ? `：${result.error}` : ''}，之后每 30 分钟复检`,
        });
      } else {
        await save(run, { ...fields, errorCode: result.errorCode, lastError: result.error, attempts: 0, nextCheckAt: new Date() });
      }
      return 'stop';
    case 'needs_confirmation':
      await save(run, { ...fields, state: 'needs_confirmation', errorCode: result.errorCode, lastError: result.error, nextCheckAt: null });
      return 'stop';
    case 'blocked':
      await save(run, {
        ...fields, state: 'blocked', errorCode: result.errorCode, lastError: result.error, attempts: 0,
        nextCheckAt: later(result.errorCode === 'mx_removed_routing_pending' ? MX_PENDING_RECHECK_MS : BLOCKED_RECHECK_MS),
      });
      return 'stop';
    case 'transient': {
      const attempts = run.row.attempts + 1;
      await save(run, { ...fields, errorCode: result.errorCode || 'cf_transient', lastError: result.error, attempts, nextCheckAt: later(retryDelay(attempts)) });
      return 'stop';
    }
    case 'stopped': {
      // 已请求取消：续租并同轮处理取消；租约丢失或到截止时间：交给下一轮
      const keep = run.cancelSeen;
      const ok = await save(run, { ...fields, nextCheckAt: new Date() }, keep);
      return ok && keep ? 'continue' : 'stop';
    }
  }
}

/**
 * finalizing：一个 batch 完成「加入系统域名列表 + 任务置 completed + 审计」。
 * CAS 守卫：revision 未变、未被托管、本任务仍持租约且是 finalizing、未请求取消；任务更新以「域名已在列表」为条件，
 * CAS 没写入时它自然不生效。冲突时重读重试，最多 3 次，仍冲突留到下一轮。新条目追加到末尾，不改变已有条目的顺序。
 */
async function finalize(run: Run): Promise<Step> {
  const { env, id, token } = run;
  const domain = run.row.domain;
  for (let attempt = 0; attempt < FINALIZE_ATTEMPTS; attempt++) {
    const current = await env.db.prepare(`SELECT (SELECT value FROM settings WHERE key = 'domains') AS domains,
        ${hostedTakenSql('?1')} AS hosted,
        (SELECT cancel_requested_at IS NOT NULL FROM system_domain_onboarding
          WHERE id = ?2 AND lease_token = ?3 AND state = 'finalizing') AS cancelled`)
      .bind(domain, id, token).first<{ domains: string | null; hosted: number; cancelled: number | null }>();
    if (current?.cancelled === null || current?.cancelled === undefined) return 'stop';
    if (Number(current.cancelled) === 1) {
      // 取消先写入：续租后由同一轮处理取消
      return (await save(run, {}, true)) ? 'continue' : 'stop';
    }
    const domains = parseDomains(current.domains);
    if (!domains) {
      await save(run, { errorCode: 'settings_invalid', lastError: '系统域名设置无法解析，未写入；请先在设置页修复', nextCheckAt: later(BLOCKED_RECHECK_MS) });
      return 'stop';
    }
    const listed = domains.list.some((entry) => entry.domain === domain);
    if (!listed && Number(current.hosted) === 1) {
      await save(run, { state: 'blocked', errorCode: 'occupied', lastError: '该域名已被用户托管', nextCheckAt: later(BLOCKED_RECHECK_MS) });
      return 'stop';
    }
    if (!listed && domains.list.length >= MAX_SYSTEM_DOMAINS) {
      await save(run, {
        state: 'blocked', errorCode: 'list_full', lastError: `系统域名已达 ${MAX_SYSTEM_DOMAINS} 个上限，请先移除不用的域名`,
        nextCheckAt: later(BLOCKED_RECHECK_MS),
      });
      return 'stop';
    }
    // 完成以「域名已在列表」为条件：本次 CAS 没写入、但其他写入恰好加入了该域名时同样完成，revision 以写入后的实际值为准
    const detail = `任务 #${id}；${run.row.mode === 'new_zone' ? '新建 zone' : '已有 zone'} ${run.row.zoneId ?? ''}（${ORIGIN_LABEL[run.row.zoneOrigin]}）；`
      + `${listed ? '域名已在系统域名列表中' : '加入系统域名（仅管理员可认领）'}，revision `;
    const statements: D1PreparedStatement[] = [];
    if (!listed) {
      const value = JSON.stringify({ list: [...domains.list, { domain, ...DEFAULT_ENTRY }], revision: domains.revision + 1 });
      statements.push(env.db.prepare(domainsCasSql(`NOT ${hostedTakenSql('?3')} AND EXISTS (SELECT 1 FROM system_domain_onboarding
          WHERE id = ?4 AND lease_token = ?5 AND state = 'finalizing' AND cancel_requested_at IS NULL)`))
        .bind(value, domains.revision, domain, id, token));
    }
    statements.push(
      env.db.prepare(`UPDATE system_domain_onboarding SET state = 'completed', settings_revision = ${DOMAINS_REVISION_SQL},
          finished_at = ?1, state_changed_at = ?1, updated_at = ?1, next_check_at = NULL, lease_token = NULL, lease_until = NULL,
          error_code = '', last_error = '', attempts = 0
        WHERE id = ?2 AND lease_token = ?3 AND state = 'finalizing' AND cancel_requested_at IS NULL AND ${systemDomainListedSql('?4')}`)
        .bind(Date.now(), id, token, domain),
      env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
        SELECT ?1, ?2, 'system_domain.complete', ?3, ?4 || ${DOMAINS_REVISION_SQL}, '' WHERE changes() = 1`)
        .bind(SYSTEM_ACTOR.id, SYSTEM_ACTOR.username, domain, detail),
    );
    const results = await env.db.batch(statements);
    if (results[statements.length - 2]?.meta.changes === 1) {
      invalidateSettingsMemory();
      return 'stop';
    }
  }
  await save(run, {
    errorCode: 'settings_conflict', lastError: '系统域名列表连续被其他修改抢先，下一轮继续', nextCheckAt: new Date(),
  });
  return 'stop';
}

const DOMAINS_REVISION_SQL = "COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0)";
const ORIGIN_LABEL: Record<SystemDomainZoneOrigin, string> = { created: '本任务创建', linked: '关联已有', unknown: '来源未确认' };

/** settings.domains 原值（行不存在为空列表；解析失败返回 null，不能据此覆盖写入） */
function parseDomains(value: string | null): { list: DomainEntry[]; revision: number } | null {
  if (value === null) return { list: [], revision: 0 };
  try {
    const parsed = SETTING_SCHEMAS.domains.safeParse(JSON.parse(value));
    return parsed.success ? { list: parsed.data.list, revision: parsed.data.revision ?? 0 } : null;
  } catch {
    return null;
  }
}

/**
 * 取消（处理器在检查点执行）：本任务创建、从未激活、勾选了删除且 zone 仍未激活时删除 zone（唯一的 deleteZone 调用点），
 * 其余情况不访问 Cloudflare、不回滚已做的配置。建 zone 的请求可能仍在途中：等到占位 10 分钟后按名称确认，找到的 zone 只记录、保留。
 */
async function stepCancel(run: Run): Promise<Step> {
  const { row } = run;
  const finish = async (fields: OnboardingFields = {}, note = '') => {
    await save(run, { ...fields, state: 'cancelled', finishedAt: new Date(), nextCheckAt: null, errorCode: '', lastError: note });
    return 'stop' as const;
  };
  // 没有凭据或换了账户：不调用 Cloudflare
  if (!run.creds || row.accountId !== run.creds.accountId) return finish();
  const creds = run.creds;
  if (!row.zoneId) {
    if (row.mode !== 'new_zone') return finish();
    const due = row.createdAt.getTime() + RESERVATION_STALE_MS;
    if (Date.now() < due) {
      await save(run, { state: 'cancelling', nextCheckAt: new Date(due) });
      return 'stop';
    }
    if (!(await save(run, { state: 'cancelling' }, true))) return 'stop';
    await spend(run, 1);
    const zone = await findZone(creds, row.domain);
    if (zone && adoptable(zone, row)) {
      await record(run, { seq: 1, kind: 'zone.create', status: 'done', target: zone.id, error: '请求结果不明，按名称找回（来源未确认，已保留）' });
      return finish(zoneFields(zone), '建 zone 的请求实际已生效，来源未确认，zone 已保留');
    }
    return finish();
  }
  if (row.zoneOrigin === 'created' && row.activatedAt === null && row.cancelDeleteZone) {
    if (!(await save(run, { state: 'cancelling' }, true))) return 'stop';
    await spend(run, 2);
    const zone = await getZone(creds, row.zoneId, row.domain);
    if (!zone) return finish({ zoneStatus: 'missing' });
    if (isWaiting(zone)) {
      const seq = await record(run, { kind: 'zone.delete', status: 'started', target: zone.id });
      await deleteZone(creds, zone.id, row.domain);
      await record(run, { seq, kind: 'zone.delete', status: 'done', target: zone.id });
      await logAdminAction(run.env, SYSTEM_ACTOR, 'system_domain.zone_delete', row.domain,
        `任务 #${row.id}：删除本任务创建、从未激活的 zone ${zone.id}（取消人 #${row.cancelRequestedBy ?? 0}）`);
      return finish({ zoneStatus: 'missing' });
    }
    return finish({ zoneStatus: zone.status }, '取消时 zone 已激活，按规则保留');
  }
  return finish();
}

// ---------------------------------------------------------------------------
// 管理员操作

type CreateRequest = { mode: 'new_zone'; domain: string; fingerprint?: string; accept: SystemDomainAck[] }
  | { mode: 'existing_zone'; zoneId: string; fingerprint?: string; accept: SystemDomainAck[] };

const conflictWith = (message: string, precheck: SystemDomainPrecheck) => new AppError('conflict', message, { details: { precheck } });

const ACK_LABEL: Record<SystemDomainAck, string> = {
  'ns.change': '修改 NS', 'mx.delete': '删除第三方 MX', 'catchAll.replace': '替换 catch-all', 'spf.merge': '合并 SPF',
  'rules.bypass': '专用地址规则不经本站', 'dmarc.create': '写入 DMARC p=reject',
};
const ackLabels = (accepted: readonly OnboardingAcceptance[]) => acksOf(accepted).map((ack) => ACK_LABEL[ack]).join('、');

/** 创建时的门禁：有阻断项，或需确认项没有全部 accept、指纹不一致时 409（带最新预检）；通过时返回已确认项 */
function gateCreate(ev: Evaluation, req: CreateRequest): OnboardingAcceptance[] {
  const { precheck } = ev;
  const blocker = precheck.checks.find((item) => item.severity === 'blocker');
  if (blocker) throw conflictWith(blocker.title, precheck);
  if (precheck.requiredAcks.length) {
    if (!req.fingerprint || precheck.requiredAcks.some((ack) => !req.accept.includes(ack))) {
      throw conflictWith(`需要确认 ${precheck.requiredAcks.length} 项变更`, precheck);
    }
    if (req.fingerprint !== precheck.fingerprint) throw conflictWith(STALE_FINGERPRINT, precheck);
  }
  return ev.snapshot.observed.filter((item) => req.accept.includes(item.ack));
}

interface Reservation {
  domain: string;
  mode: SystemDomainOnboardingMode;
  state: SystemDomainOnboardingState;
  accountId: string;
  zone: CfZone | null;
  origin: SystemDomainZoneOrigin;
  ev: Evaluation;
  accepted: OnboardingAcceptance[];
  createdBy: number;
  leaseToken: string | null;
  nextCheckAt: number | null;
  changes: OnboardingChangeEvent[];
}

/**
 * 原子占位：不在系统列表、未被托管、没有进行中的同名任务，且系统列表条数 + 进行中任务数 < 64；
 * new_zone 另要求等待 NS 的 zone（托管 pending + 系统新建）未达 hosted_domains.maxPendingTotal。部分唯一索引兜底。
 */
async function reserve(env: Env, r: Reservation): Promise<OnboardingRow | null> {
  const now = Date.now();
  const snapshot = r.ev.plan?.snapshot;
  const values: [string, unknown][] = [
    ['domain', r.domain], ['mode', r.mode], ['state', r.state], ['account_id', r.accountId], ['zone_id', r.zone?.id ?? null],
    ['zone_origin', r.origin], ['zone_status', r.zone?.status ?? ''], ['name_servers', JSON.stringify(r.zone?.name_servers ?? [])],
    ['original_name_servers', JSON.stringify(r.zone?.original_name_servers ?? [])], ['original_registrar', r.zone?.original_registrar ?? ''],
    ['dnssec', r.ev.precheck.dnssec ?? 'unknown'],
    ['routing_state', snapshot?.routing.state ?? 'unknown'], ['routing_status', snapshot?.routing.status ?? ''],
    ['catch_all_state', snapshot?.catchAll.state ?? 'unknown'], ['sending_state', snapshot?.sending.state ?? 'unknown'],
    ['sending_status', snapshot?.sending.status ?? ''], ['sending_tag', snapshot?.sending.tag ?? null],
    ['preflight', JSON.stringify(r.ev.snapshot)], ['accepted', JSON.stringify(r.accepted)],
    ['confirmed_by', r.accepted.length ? r.createdBy : null], ['confirmed_at', r.accepted.length ? now : null],
    ['changes', JSON.stringify(r.changes)], ['created_by', r.createdBy], ['lease_token', r.leaseToken],
    ['lease_until', r.leaseToken ? now + LEASE_MS : null], ['next_check_at', r.nextCheckAt], ['checked_at', now],
    ['state_changed_at', now], ['updated_at', now], ['created_at', now],
  ];
  const n = values.length;
  const statement = env.db.prepare(`INSERT INTO system_domain_onboarding (${values.map(([column]) => column).join(', ')})
    SELECT ${values.map((_, i) => `?${i + 1}`).join(', ')}
    WHERE NOT ${systemDomainListedSql('?1')} AND NOT ${hostedTakenSql('?1')} AND NOT ${onboardingActiveSql('?1')}
      AND ${SYSTEM_DOMAIN_COUNT_SQL} + ${ACTIVE_ONBOARDING_COUNT_SQL} < ${MAX_SYSTEM_DOMAINS}
      AND (?2 <> 'new_zone' OR (SELECT COUNT(*) FROM hosted_domains WHERE status = 'pending') + ${SYSTEM_PENDING_ZONES_SQL}
        < COALESCE((SELECT json_extract(value, '$.maxPendingTotal') FROM settings WHERE key = 'hosted_domains'), ?${n + 1}))
    RETURNING *`).bind(...values.map(([, value]) => value), DEFAULT_SETTINGS.hosted_domains.maxPendingTotal);
  try {
    const raw = await statement.first<Record<string, unknown>>();
    return raw ? rowFromRaw(raw) : null;
  } catch (error) {
    // 部分唯一索引兜底：同名进行中的任务
    if (/UNIQUE constraint failed/i.test(errorText(error))) return null;
    throw error;
  }
}

/** 占位没写入：按 D1 现状给出具体原因（已是系统域名、已被托管、正在接入、列表已满、等待 NS 的配额） */
async function reservationConflict(env: Env, ev: Evaluation, mode: SystemDomainOnboardingMode): Promise<AppError> {
  const checks = occupancyChecks(ev.precheck.domain, await occupancyFacts(env, ev.precheck.domain), mode);
  const precheck: SystemDomainPrecheck = {
    ...ev.precheck,
    checks: [...checks, ...ev.precheck.checks.filter((item) => item.key !== 'occupancy' && item.key !== 'capacity')],
  };
  const blocker = checks.find((item) => item.severity === 'blocker');
  if (blocker) precheck.verdict = 'blocked';
  return conflictWith(blocker?.title ?? '域名状态已改变，请刷新后重试', precheck);
}

/** 建 zone 的确定性失败：映射为可读原因（与托管一致；1061 改为引导到可接入列表） */
function zoneCreateError(error: unknown): AppError {
  if (!(error instanceof CloudflareApiError)) return new AppError('internal', `Cloudflare 创建 zone 失败：${errorText(error)}`);
  if (error.status === 429) return cfBusyError();
  if (error.has(1061)) return new AppError('conflict', '该域名已在 Cloudflare 账户中，请在可接入列表中接入');
  if (error.has(1049)) return new AppError('validation_failed', '该域名尚未注册，请先在注册商完成注册');
  if (error.has(1099, 1093, 1116)) return new AppError('validation_failed', '请填写已注册的根域名（例如 example.com，而不是 mail.example.com）');
  if (error.has(1110)) return new AppError('validation_failed', '暂时查不到该域名的注册信息，请稍后重试');
  if (error.has(1097)) return new AppError('validation_failed', 'Cloudflare 不允许添加该域名');
  if (error.has(1105)) return new AppError('rate_limited', 'Cloudflare 提示该域名尝试次数过多，请 3 小时后再试');
  if (error.has(1118)) return new AppError('rate_limited', '站长的 Cloudflare 账户暂时不能添加更多域名，请稍后再试');
  return new AppError('internal', `Cloudflare 创建 zone 失败：${error.message}`);
}

/**
 * 一键接入（POST /onboardings）。同一域名、同一方式（existing 还要同一 zone）的进行中任务直接返回（created=false）。
 * 服务端重新预检并过门禁后原子占位：已有且已激活的 zone 进入配置并在后台执行；未激活的进入等待 NS；
 * new_zone 在请求内建 zone，结果不明时保留 creating_zone，约 10 分钟后由定时任务按名称确认。
 */
export async function createOnboarding(
  env: Env, actor: Actor, req: CreateRequest, ctx?: ExecCtx | null, ip = '',
): Promise<{ view: SystemDomainOnboarding; created: boolean }> {
  const creds = requireCredentials(env);
  const replay = await createDb(env).select().from(systemDomainOnboarding).where(and(activeSql,
    req.mode === 'new_zone' ? eq(systemDomainOnboarding.domain, req.domain) : eq(systemDomainOnboarding.zoneId, req.zoneId))).get();
  if (replay) {
    if (replay.mode === req.mode) return { view: await getOnboarding(env, replay.id), created: false };
    throw new AppError('conflict', `该域名正在以其他方式接入（任务 #${replay.id}），请先取消`);
  }
  return req.mode === 'existing_zone'
    ? createExisting(env, creds, actor, req, ctx, ip)
    : createNewZone(env, creds, actor, req, ip);
}

async function createExisting(
  env: Env, creds: CloudflareCredentials, actor: Actor, req: Extract<CreateRequest, { mode: 'existing_zone' }>, ctx: ExecCtx | null | undefined,
  ip: string,
): Promise<{ view: SystemDomainOnboarding; created: boolean }> {
  const ev = await existingEvaluation(env, creds, req.zoneId);
  const zone = ev.zone!;
  const accepted = gateCreate(ev, req);
  const active = zone.status === 'active';
  const token = active ? crypto.randomUUID() : null;
  const row = await reserve(env, {
    domain: zone.name, mode: 'existing_zone', state: active ? 'configuring' : 'awaiting_ns', accountId: creds.accountId, zone,
    origin: 'linked', ev, accepted, createdBy: actor.id, leaseToken: token,
    nextCheckAt: active ? null : Date.now() + AWAITING_NS_RECHECK_MS, changes: [],
  });
  if (!row) throw await reservationConflict(env, ev, 'existing_zone');
  await logAdminAction(env, actor, 'system_domain.create', zone.name,
    `已有 zone ${zone.id}（${zone.status}）${accepted.length ? `；随创建一并确认：${ackLabels(accepted)}` : ''}`, ip);
  if (token) {
    // 刚做完的预检直接用于配置，不重复读取；被截断时租约过期后由定时任务接手
    await runDetached(ctx, () => drive(newRun(env, creds, { row, token, pool: 0 }, { prepared: ev })));
  }
  return { view: await getOnboarding(env, row.id), created: true };
}

async function createNewZone(
  env: Env, creds: CloudflareCredentials, actor: Actor, req: Extract<CreateRequest, { mode: 'new_zone' }>, ip: string,
): Promise<{ view: SystemDomainOnboarding; created: boolean }> {
  // 查同名 zone 与建 zone 各 1 次
  await requireCfCalls(env, 2);
  const ev = await evaluateNewZone(env, creds, req.domain);
  const accepted = gateCreate(ev, req);
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await reserve(env, {
    domain: req.domain, mode: 'new_zone', state: 'creating_zone', accountId: creds.accountId, zone: null, origin: 'unknown', ev, accepted,
    createdBy: actor.id, leaseToken: token, nextCheckAt: now + RESERVATION_STALE_MS,
    changes: [{ seq: 1, kind: 'zone.create', status: 'started', at: now }],
  });
  if (!row) throw await reservationConflict(env, ev, 'new_zone');
  await logAdminAction(env, actor, 'system_domain.create', req.domain, `新建 zone；随创建一并确认：${ackLabels(accepted)}`, ip);
  const run = newRun(env, creds, { row, token, pool: 0 });

  let zone: CfZone;
  try {
    zone = await createZone(creds, req.domain);
  } catch (error) {
    if (isOutcomeUnknown(error)) {
      // zone 可能已经建好：保留占位，到期后按名称确认（采纳的 zone 来源为 unknown，永不删除）
      await record(run, { seq: 1, kind: 'zone.create', status: 'unknown', error: errorText(error) });
      await save(run, { errorCode: 'cf_transient', lastError: 'Cloudflare 暂时没有响应，系统约 10 分钟内确认' });
      return { view: await getOnboarding(env, row.id), created: true };
    }
    await noteThrottle(env, error);
    const mapped = zoneCreateError(error);
    await record(run, { seq: 1, kind: 'zone.create', status: 'failed', error: errorText(error) });
    await fail(run, 'create_failed', mapped.message);
    throw mapped;
  }
  await record(run, { seq: 1, kind: 'zone.create', status: 'done', target: zone.id });
  // 回填不看租约：「这个 zone 是本任务建的」这条信息不能丢。期间已请求取消时转入 cancelling 立即处理
  await env.db.prepare(`UPDATE system_domain_onboarding SET zone_id = ?1, zone_origin = 'created', zone_status = ?2,
      name_servers = ?3, original_name_servers = ?4, original_registrar = ?5, error_code = '', last_error = '',
      state = CASE WHEN cancel_requested_at IS NULL THEN 'awaiting_ns' ELSE 'cancelling' END, state_changed_at = ?6, updated_at = ?6,
      next_check_at = CASE WHEN cancel_requested_at IS NULL THEN ?7 ELSE ?6 END,
      lease_token = CASE WHEN lease_token = ?8 THEN NULL ELSE lease_token END,
      lease_until = CASE WHEN lease_token = ?8 THEN NULL ELSE lease_until END
    WHERE id = ?9 AND zone_id IS NULL AND state NOT IN ${ONBOARDING_TERMINAL_SQL}`)
    .bind(zone.id, zone.status, JSON.stringify(zone.name_servers ?? []), JSON.stringify(zone.original_name_servers ?? []),
      zone.original_registrar ?? '', Date.now(), Date.now() + AWAITING_NS_RECHECK_MS, token, row.id).run();
  return { view: await getOnboarding(env, row.id), created: true };
}

/** 立即检测或重试（POST /:id/check）：15 秒内重复或正被处理时直接返回当前视图 */
export async function checkOnboarding(env: Env, id: number): Promise<SystemDomainOnboarding> {
  const creds = requireCredentials(env);
  const row = await loadRow(env, id);
  if (isTerminal(row.state)) throw new AppError('conflict', '接入已结束');
  const { lease, overBudget } = await acquireLease(env, id, 'manual', callsFor(row.state, true));
  if (overBudget) throw cfBusyError();
  if (lease) await drive(newRun(env, creds, lease, { activationCheck: true }));
  return getOnboarding(env, id);
}

/**
 * 确认（POST /:id/confirm）：配置途中远端变化（指纹漂移）后使用。持租约重新预检：
 * 有阻断项或指纹过期 409（带最新预检，并写回最新快照）；accept 没覆盖全部需确认项 400；通过后进入配置并在后台继续。
 */
export async function confirmOnboarding(
  env: Env, actor: Actor, id: number, req: { fingerprint: string; accept: SystemDomainAck[] }, ctx?: ExecCtx | null, ip = '',
): Promise<SystemDomainOnboarding> {
  const creds = requireCredentials(env);
  const row = await loadRow(env, id);
  if (isTerminal(row.state)) throw new AppError('conflict', '接入已结束');
  if (row.state !== 'needs_confirmation' || row.cancelRequestedAt) throw new AppError('conflict', '当前状态不需要确认');
  const { lease, overBudget } = await acquireLease(env, id, 'force', callsFor('configuring'));
  if (overBudget) throw cfBusyError();
  if (!lease) throw new AppError('conflict', '正在检查，请稍后再试');
  const run = newRun(env, creds, lease);
  let ev: Evaluation | null;
  try {
    if (lease.row.state !== 'needs_confirmation' || lease.row.cancelRequestedAt) throw new AppError('conflict', '当前状态不需要确认');
    ev = await inspectFresh(run);
    if (!ev) throw new AppError('conflict', run.row.lastError || '任务状态已改变，请刷新后重试');
    const { precheck } = ev;
    const blocker = precheck.checks.find((item) => item.severity === 'blocker');
    const missing = precheck.requiredAcks.filter((ack) => !req.accept.includes(ack));
    if (blocker || precheck.fingerprint !== req.fingerprint || missing.length) {
      // 写回最新快照（有阻断项时转入 blocked）；远端恰好回到已确认过的状态时不需要再确认，照常继续
      const state = await decide(run, ev);
      if (!state) {
        if (blocker) throw conflictWith(blocker.title, precheck);
        if (precheck.fingerprint !== req.fingerprint) throw conflictWith(STALE_FINGERPRINT, precheck);
        throw new AppError('validation_failed', `还有 ${missing.length} 项变更未确认`, { details: { precheck } });
      }
    } else {
      const accepted = ev.snapshot.observed;
      if (!(await save(run, {
        ...evaluationFields(ev, run.row), state: 'configuring', accepted, confirmedBy: actor.id, confirmedAt: new Date(),
        errorCode: '', lastError: '',
      }, true))) throw new AppError('conflict', '正在检查，请稍后再试');
      await logAdminAction(env, actor, 'system_domain.confirm', row.domain, ackLabels(accepted), ip);
    }
  } catch (error) {
    await save(run, {});
    if (error instanceof AppError) throw error;
    await noteThrottle(env, error);
    throw new AppError('internal', `读取 Cloudflare 配置失败：${errorText(error)}`);
  }
  run.prepared = ev;
  run.deadline = Date.now() + API_DEADLINE_MS;
  await runDetached(ctx, () => drive(run));
  return getOnboarding(env, id);
}

/**
 * 取消（POST /:id/cancel）：只置标记（不需要租约），没有其他执行者时立即处理；否则由持有租约的处理器在检查点处理。
 * 与完成写入的竞争：完成的 CAS 守卫带「未请求取消」，谁先写入谁生效，取消落败返回 409。
 */
export async function cancelOnboarding(
  env: Env, actor: Actor, id: number, req: { deleteCreatedZone: boolean }, ip = '',
): Promise<SystemDomainOnboarding> {
  const row = await loadRow(env, id);
  const finished = (state: SystemDomainOnboardingState) => new AppError('conflict',
    state === 'completed' ? `接入已完成，${CANCEL_KEEPS}` : '接入已结束');
  if (isTerminal(row.state)) throw finished(row.state);
  if (req.deleteCreatedZone && !canDeleteZone(row)) {
    throw new AppError('validation_failed', '只能删除本任务创建、从未激活的 zone；关联已有或来源不明的 zone 不会删除');
  }
  const now = Date.now();
  const flagged = await env.db.prepare(`UPDATE system_domain_onboarding SET cancel_requested_at = COALESCE(cancel_requested_at, ?1),
      cancel_requested_by = COALESCE(cancel_requested_by, ?2), cancel_delete_zone = ?3, next_check_at = ?1, updated_at = ?1
    WHERE id = ?4 AND state NOT IN ${ONBOARDING_TERMINAL_SQL} RETURNING id`)
    .bind(now, actor.id, req.deleteCreatedZone ? 1 : 0, id).first();
  if (!flagged) throw finished((await loadRow(env, id)).state);
  if (!row.cancelRequestedAt) {
    await logAdminAction(env, actor, 'system_domain.cancel', row.domain,
      `任务 #${id}${req.deleteCreatedZone ? '；删除本任务创建、从未激活的 zone' : row.zoneId ? '；保留 zone 与已做的配置' : ''}`, ip);
  }
  const creds = cloudflareCredentials(env);
  const { lease, overBudget } = await acquireLease(env, id, 'force', req.deleteCreatedZone ? 2 : 0);
  if (overBudget) throw cfBusyError();
  if (lease) await drive(newRun(env, creds, lease));
  return getOnboarding(env, id);
}

// ---------------------------------------------------------------------------
// 定时任务

/** 每轮最多处理 limit 条到期任务（墙钟截止时间到点不再取下一条）；额度不足或在 429 退避期内时跳过本轮 */
export async function syncDueOnboarding(env: Env, opts: { limit?: number; deadline?: number } = {}): Promise<number> {
  const creds = cloudflareCredentials(env);
  if (!creds) return 0;
  const deadline = opts.deadline ?? Date.now() + CRON_DEADLINE_MS;
  const now = Date.now();
  const due = await env.db.prepare(`SELECT id, state, cancel_requested_at IS NOT NULL AS cancelling FROM system_domain_onboarding
      WHERE state IN ('creating_zone', 'awaiting_ns', 'needs_confirmation', 'blocked', 'configuring', 'finalizing', 'cancelling')
        AND next_check_at <= ?1 AND (lease_until IS NULL OR lease_until < ?1)
      ORDER BY next_check_at LIMIT ?2`).bind(now, opts.limit ?? CRON_ONBOARDING_LIMIT)
    .all<{ id: number; state: SystemDomainOnboardingState; cancelling: number }>();
  let processed = 0;
  for (const candidate of due.results) {
    if (Date.now() > deadline) break;
    try {
      const calls = callsFor(Number(candidate.cancelling) === 1 ? 'cancelling' : candidate.state);
      const { lease, overBudget } = await acquireLease(env, candidate.id, 'cron', calls);
      if (overBudget) break;
      if (!lease) continue;
      await drive(newRun(env, creds, lease, { deadline }));
      processed += 1;
    } catch (error) {
      console.error(`系统域名接入任务 #${candidate.id} 定时处理失败:`, error);
    }
  }
  return processed;
}
