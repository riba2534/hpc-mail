import type { ClaimPlan, ClaimPlanItem, ClaimPlanStrategy, DomainClaudeStats, Role, Settings } from '@hpc-mail/shared';
import type { Env } from '../types.js';
import { ownedCountsFromResult, ownedCountsStatement } from './mailbox.js';
import { asActor, mailboxPolicyUserFromResult, mailboxPolicyUserStatement, resolveMailboxPolicy } from './mailbox-policy.js';
import { mergeSettingRows } from './setting.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 未注册邮箱按认领天数分桶读取，窗口上限与 claim_random.pendingDays 的上限一致 */
const PENDING_MAX_DAYS = 90;

interface DomainCounts {
  accounts: number;
  suspended: number;
  paid: number;
  paidSuspended: number;
  pending: number;
  /** 近 24 小时新增：首次来信在 24 小时内的账号 + 24 小时内认领的未注册邮箱 */
  recent: number;
}

const EMPTY_COUNTS: DomainCounts = { accounts: 0, suspended: 0, paid: 0, paidSuspended: 0, pending: 0, recent: 0 };

/**
 * 每个后缀的账号/封号统计 + 未注册邮箱（按认领天数分桶，由调用方按 pendingDays 截取）。
 * 两边互斥（有事实的地址不算未注册），近 24 小时新增由两边相加，不会重复计数。
 */
function domainCountStatements(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare(`SELECT domain, COUNT(*) AS accounts, SUM(suspended) AS suspended, SUM(paid) AS paid,
      SUM(paid AND suspended) AS paid_suspended, SUM(first_seen_at >= ?1) AS recent FROM claude_address_facts GROUP BY domain`)
      .bind(now - DAY_MS),
    db.prepare(`SELECT domain, CAST((?1 - created_at) / ${DAY_MS} AS INTEGER) AS age_days, COUNT(*) AS n FROM mailboxes m
      WHERE created_at >= ?2 AND NOT EXISTS (SELECT 1 FROM claude_address_facts f WHERE f.address = m.address)
      GROUP BY domain, age_days`).bind(now, now - PENDING_MAX_DAYS * DAY_MS),
  ];
}

function domainCountsFrom(stats: D1Result | undefined, pending: D1Result | undefined, pendingDays: number): Map<string, DomainCounts> {
  const counts = new Map<string, DomainCounts>();
  const entry = (domain: string) => counts.get(domain) ?? counts.set(domain, { ...EMPTY_COUNTS }).get(domain)!;
  for (const row of (stats?.results ?? []) as { domain: string; accounts: number; suspended: number; paid: number; paid_suspended: number; recent: number }[]) {
    Object.assign(entry(row.domain), {
      accounts: Number(row.accounts), suspended: Number(row.suspended), paid: Number(row.paid), paidSuspended: Number(row.paid_suspended),
      recent: Number(row.recent),
    });
  }
  for (const row of (pending?.results ?? []) as { domain: string; age_days: number; n: number }[]) {
    const domainCounts = entry(row.domain);
    if (Number(row.age_days) < pendingDays) domainCounts.pending += Number(row.n);
    if (Number(row.age_days) === 0) domainCounts.recent += Number(row.n);
  }
  return counts;
}

/** 任意历史封号均排除，不受账号数、付费状态或已弃用阈值影响。 */
export function domainRisk(counts: Pick<DomainCounts, 'suspended'>): DomainClaudeStats['risk'] {
  return counts.suspended > 0 ? 'suspended' : null;
}

export interface PlanCandidate {
  domain: string;
  suspended: number;
  /** 已有账号 + 未注册邮箱；本批每分到一个加 1 */
  load: number;
  /** 近 24 小时新增；本批每分到一个加 1 */
  recent: number;
  /** 当前用户在该后缀还能认领的个数，Infinity 表示不限 */
  remaining: number;
}

function randomIndex(n: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % n;
}

/**
 * Claude 0 封号分配：只取没有封号记录的后缀，逐个选择负载最小的后缀，平局随机。
 * 每分到一个就累计负载与近 24 小时新增；每日上限或每域额度用完就停，不能溢出到有封号的后缀。
 */
export function allocateLowRisk(candidates: PlanCandidate[], count: number, dailyLimit = 0, random = randomIndex): ClaimPlanItem[] {
  const pool = candidates.filter((candidate) => candidate.suspended === 0).map((candidate) => ({ ...candidate }));
  const items: ClaimPlanItem[] = [];
  while (items.length < count) {
    const safest = pool.filter((candidate) => candidate.remaining > 0 && (dailyLimit === 0 || candidate.recent < dailyLimit));
    if (safest.length === 0) break;
    const lightest = Math.min(...safest.map((candidate) => candidate.load));
    const ties = safest.filter((candidate) => candidate.load === lightest);
    const picked = ties[random(ties.length)]!;
    picked.load += 1;
    picked.recent += 1;
    picked.remaining -= 1;
    items.push({ domain: picked.domain, suspended: picked.suspended });
  }
  return items;
}

/** 均匀随机：在还有额度的后缀里等概率选 */
export function allocateUniform(candidates: PlanCandidate[], count: number, random = randomIndex): ClaimPlanItem[] {
  const pool = candidates.map((candidate) => ({ ...candidate }));
  const items: ClaimPlanItem[] = [];
  while (items.length < count) {
    const open = pool.filter((candidate) => candidate.remaining > 0);
    if (open.length === 0) break;
    const picked = open[random(open.length)]!;
    picked.remaining -= 1;
    items.push({ domain: picked.domain, suspended: picked.suspended });
  }
  return items;
}

const PLAN_SETTINGS_SQL = `SELECT key, value FROM settings WHERE key IN ('domains', 'mailbox_policy', 'claim_random')`;

/**
 * 为当前用户分配 count 个随机后缀（不认领）。规则、用户权限、已认领数和后缀统计一次 D1 batch 读齐；
 * 候选只取当前用户可认领且参与随机的域名，并按每域与全局剩余额度裁剪。
 */
export async function planRandomDomains(
  env: Env,
  actor: { userId: number; role: Role },
  count: number,
  strategy: ClaimPlanStrategy,
  random = randomIndex,
): Promise<ClaimPlan> {
  const now = Date.now();
  const [settingsResult, userResult, ownedResult, statsResult, pendingResult] = await env.db.batch([
    env.db.prepare(PLAN_SETTINGS_SQL),
    mailboxPolicyUserStatement(env.db, actor.userId),
    ownedCountsStatement(env.db, actor.userId),
    ...domainCountStatements(env.db, now),
  ]);
  const settings: Settings = mergeSettingRows((settingsResult?.results ?? []) as { key: string; value: string }[]);
  const policy = resolveMailboxPolicy(settings, asActor(mailboxPolicyUserFromResult(userResult), actor.role));
  const owned = ownedCountsFromResult(ownedResult);
  const rules = settings.claim_random;
  const counts = domainCountsFrom(statsResult, pendingResult, rules.pendingDays);

  const randomEnabled = new Set(settings.domains.list.filter((entry) => entry.random !== false).map((entry) => entry.domain));
  const candidates: PlanCandidate[] = policy.domains
    .filter(({ domain }) => randomEnabled.has(domain))
    .map(({ domain, perUserLimit }) => {
      const domainCounts = counts.get(domain) ?? EMPTY_COUNTS;
      return {
        domain,
        suspended: domainCounts.suspended,
        load: domainCounts.accounts + domainCounts.pending,
        recent: domainCounts.recent,
        remaining: perUserLimit > 0 ? Math.max(0, perUserLimit - (owned.byDomain.get(domain) ?? 0)) : Infinity,
      };
    });
  const eligible = strategy === 'claude'
    ? candidates.filter(({ domain }) => domainRisk(counts.get(domain) ?? EMPTY_COUNTS) === null)
    : candidates;
  const dailyLimit = strategy === 'claude' ? rules.dailyLimit : 0;
  const totalRemaining = policy.perUserLimit > 0 ? Math.max(0, policy.perUserLimit - owned.total) : Infinity;
  const target = Math.min(count, totalRemaining);
  const items = strategy === 'claude' ? allocateLowRisk(eligible, target, dailyLimit, random) : allocateUniform(eligible, target, random);
  const shortfall = count - items.length;
  return {
    strategy,
    items,
    pool: eligible.filter((candidate) => candidate.remaining > 0).map((candidate) => candidate.domain),
    shortfall,
    reason: shortfall === 0 ? null : shortfallReason(eligible, items, target, count),
  };
}

/** 分不满的原因：没有候选 → 用户总额度 → 停在每日上限还是每域额度 */
function shortfallReason(eligible: PlanCandidate[], items: ClaimPlanItem[], target: number, count: number): ClaimPlan['reason'] {
  if (eligible.length === 0) return 'no_candidates';
  if (items.length === target && target < count) return 'quota';
  const allocated = new Map<string, number>();
  for (const item of items) allocated.set(item.domain, (allocated.get(item.domain) ?? 0) + 1);
  // 分配停在没有可分的后缀：还有剩余每域额度，说明零封号候选都到了每日上限
  return eligible.some((candidate) => candidate.remaining > (allocated.get(candidate.domain) ?? 0)) ? 'daily_limit' : 'domain_quota';
}

/** 管理员查看：系统域名列表中每个后缀的 Claude 统计与排除原因 */
export async function getDomainClaudeStats(env: Env): Promise<DomainClaudeStats[]> {
  const [settingsResult, statsResult, pendingResult] = await env.db.batch([
    env.db.prepare(`SELECT key, value FROM settings WHERE key IN ('domains', 'claim_random')`),
    ...domainCountStatements(env.db, Date.now()),
  ]);
  const settings = mergeSettingRows((settingsResult?.results ?? []) as { key: string; value: string }[]);
  const counts = domainCountsFrom(statsResult, pendingResult, settings.claim_random.pendingDays);
  return settings.domains.list.map(({ domain }) => {
    const domainCounts = counts.get(domain) ?? EMPTY_COUNTS;
    return { domain, ...domainCounts, risk: domainRisk(domainCounts) };
  });
}
