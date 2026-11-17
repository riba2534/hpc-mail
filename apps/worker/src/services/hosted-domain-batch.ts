import type {
  ErrorCode, HostedDomain, HostedDomainBatchCheckItem, HostedDomainBatchCreateItem, HostedDomainBatchError, HostedDomainBatchOutcome,
  HostedDomainBatchResult,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { DEFAULT_ERROR_HINTS } from '../middleware/error.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import {
  CHECK_CF_CALLS, CREATE_CF_CALLS, HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE,
  MAX_HOSTED_CHECKS_PER_MINUTE, MAX_HOSTED_CREATES_PER_MINUTE, MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE, checkHostedDomain, createHostedDomain,
  hostedDomainsAvailable,
} from './hosted-domain.js';
import { counterReadStatement, counterResult, minuteWindow } from './rate-counter.js';
import { getSettings, getSettingsFresh } from './setting.js';

type Viewer = Pick<AuthUser, 'id' | 'username' | 'role'>;

interface BatchPlan {
  /** 单项操作的个人计数 scope 与每分钟上限 */
  scope: string;
  limit: number;
  /** 单项计入全站额度的 Cloudflare 调用数 */
  calls: number;
  userBusy: string;
  /** 这些错误对后续各项同样成立（账户级额度、限流、账户停用），出现后其余项不再尝试 */
  stopCodes: readonly ErrorCode[];
}

const CREATE_PLAN: BatchPlan = {
  scope: HOSTED_CREATE_RATE_SCOPE, limit: MAX_HOSTED_CREATES_PER_MINUTE, calls: CREATE_CF_CALLS,
  userBusy: `本分钟的添加次数已用完（每人每分钟 ${MAX_HOSTED_CREATES_PER_MINUTE} 次）`,
  // 添加的 forbidden 只来自每人托管上限与 pending 上限，后面的域名同样过不了
  stopCodes: ['rate_limited', 'forbidden', 'user_disabled'],
};

const CHECK_PLAN: BatchPlan = {
  scope: HOSTED_CHECK_RATE_SCOPE, limit: MAX_HOSTED_CHECKS_PER_MINUTE, calls: CHECK_CF_CALLS,
  userBusy: `本分钟的检测次数已用完（每人每分钟 ${MAX_HOSTED_CHECKS_PER_MINUTE} 次）`,
  // 检测的 forbidden 是「成员不能检测」，只与该域名有关
  stopCodes: ['rate_limited', 'user_disabled'],
};

const SITE_BUSY = '当前域名操作较多';
const RETRY_FIX = '约 1 分钟后只用未处理的项重试';

/**
 * 读本分钟的个人计数与全站额度，算出还能处理几项。只读不计数：额度不够的项不调用 service，
 * 不推高个人计数、不占全站额度、不调 Cloudflare。并发请求抢先用掉额度时，由 service 自身的原子守卫兜住。
 */
async function affordable(env: Env, viewer: Viewer, plan: BatchPlan, total: number): Promise<{ count: number; reason: string }> {
  const window = minuteWindow(1);
  const [user, site] = await env.db.batch([
    counterReadStatement(env, plan.scope, String(viewer.id), window),
    counterReadStatement(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', window),
  ]);
  const used = (result: D1Result | undefined) => counterResult(result)?.count ?? 0;
  const userLeft = Math.max(0, plan.limit - used(user));
  const siteLeft = Math.max(0, Math.floor((MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - used(site)) / plan.calls));
  return { count: Math.min(total, userLeft, siteLeft), reason: userLeft <= siteLeft ? plan.userBusy : SITE_BUSY };
}

function batchError(error: unknown): HostedDomainBatchError {
  if (error instanceof AppError) {
    const fix = error.hints.fix ?? DEFAULT_ERROR_HINTS[error.code]?.fix;
    return { code: error.code, message: error.message, ...(fix ? { fix } : {}) };
  }
  console.error('批量托管域名单项失败:', error);
  return { code: 'internal', message: '服务器内部错误' };
}

/** 按顺序逐项执行（不并发，计数与 Cloudflare 调用顺序确定）；额度外与停止后的项标为未处理 */
async function runBatch<K>(env: Env, viewer: Viewer, plan: BatchPlan, keys: K[], run: (key: K) => Promise<HostedDomain>): Promise<HostedDomainBatchOutcome[]> {
  const budget = await affordable(env, viewer, plan, keys.length);
  const outcomes: HostedDomainBatchOutcome[] = [];
  let stopped: HostedDomainBatchError | null = null;
  for (const [index, key] of keys.entries()) {
    if (stopped) {
      outcomes.push({ ok: false, error: { ...stopped, message: `未处理：${stopped.message}` } });
    } else if (index >= budget.count) {
      outcomes.push({ ok: false, error: { code: 'rate_limited', message: `未处理：${budget.reason}`, fix: RETRY_FIX } });
    } else {
      try {
        outcomes.push({ ok: true, hostedDomain: await run(key) });
      } catch (caught) {
        const error = batchError(caught);
        outcomes.push({ ok: false, error });
        if (plan.stopCodes.includes(error.code)) stopped = error.code === 'rate_limited' ? { ...error, fix: RETRY_FIX } : error;
      }
    }
  }
  return outcomes;
}

function summarize<T extends HostedDomainBatchOutcome>(items: T[]): HostedDomainBatchResult<T> {
  const succeeded = items.filter((item) => item.ok).length;
  return { items, succeeded, failed: items.length - succeeded };
}

/** 批量添加：每项与单个添加完全相同（占位守卫、额度、限流、审计），结果逐项返回 */
export async function createHostedDomains(env: Env, viewer: Viewer, domains: string[], ctx?: ExecCtx | null, ip = '')
  : Promise<HostedDomainBatchResult<HostedDomainBatchCreateItem>> {
  if (!hostedDomainsAvailable(env, await getSettingsFresh(env))) throw new AppError('forbidden', '本站未开启域名托管');
  const outcomes = await runBatch(env, viewer, CREATE_PLAN, domains, (domain) => createHostedDomain(env, viewer, domain, ctx, ip));
  return summarize(domains.map((domain, index): HostedDomainBatchCreateItem => ({ domain, ...outcomes[index]! })));
}

/** 批量立即检测：每项与单个检测相同（权限、节流、限流），无权访问的 id 逐项返回 not_found */
export async function checkHostedDomains(env: Env, viewer: Viewer, ids: number[]): Promise<HostedDomainBatchResult<HostedDomainBatchCheckItem>> {
  if (!hostedDomainsAvailable(env, await getSettings(env))) throw new AppError('forbidden', '本站未开启域名托管');
  const outcomes = await runBatch(env, viewer, CHECK_PLAN, ids, (id) => checkHostedDomain(env, viewer, id));
  return summarize(ids.map((id, index): HostedDomainBatchCheckItem => ({ id, ...outcomes[index]! })));
}
