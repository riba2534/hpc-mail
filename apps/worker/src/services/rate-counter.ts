import { and, eq, inArray, lt } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { rateCounters } from '../db/schema.js';
import type { Env } from '../types.js';

/** /v1 被拒请求的明细节流计数（每 Key 每分钟一格） */
export const API_REJECT_SCOPE = 'api-reject';
/** 普通用户外发日配额（count=封数，units=收件人数；subject 为 userId，按天窗口） */
export const OUTBOUND_QUOTA_SCOPE = 'out';

export interface CounterValue {
  count: number;
  units: number;
}

/** 当天窗口号（yyyymmdd），用于按日计的配额 */
export function dayWindow(now = new Date()): number {
  return Number(now.toISOString().slice(0, 10).replace(/-/g, ''));
}

/** 固定长度窗口号，用于按分钟计的限流（minutes=15 即 15 分钟一格） */
export function minuteWindow(minutes: number, nowMs = Date.now()): number {
  return Math.floor(nowMs / 60000 / minutes);
}

/** 守卫条件：一段返回布尔的 SQL 片段及其绑定值，不满足时计数语句不写入、也不返回行。 */
export interface CounterGuard {
  sql: string;
  params: unknown[];
}

/**
 * 守卫：某个计数在本窗口未超过 limit（行不存在按 0 计）。放在同一 batch 里该计数的
 * 递增语句之后，读到的就是包含本次请求的新值。
 */
export function counterWithinGuard(scope: string, subject: string, window: number, limit: number): CounterGuard {
  return {
    sql: 'COALESCE((SELECT count FROM rate_counters WHERE scope = ? AND subject = ? AND "window" = ?), 0) <= ?',
    params: [scope, subject, window, limit],
  };
}

/** 多个守卫取与 */
export function andGuards(...guards: CounterGuard[]): CounterGuard {
  return {
    sql: guards.map(guard => `(${guard.sql})`).join(' AND '),
    params: guards.flatMap(guard => guard.params),
  };
}

/**
 * bumpCounter 的预编译语句形态，供调用方与其他语句合进同一个 `db.batch` 往返。
 * `RETURNING count, units` 在结果的 `results[0]`；带 guard 且条件不成立时无行。
 */
export function counterStatement(
  env: Env,
  scope: string,
  subject: string,
  window: number,
  delta = 1,
  units = 0,
  guard?: CounterGuard,
): D1PreparedStatement {
  // INSERT ... SELECT 必须带 WHERE，否则 SQLite 会把 ON CONFLICT 当作 JOIN 约束解析
  return env.db.prepare(`INSERT INTO rate_counters (scope, subject, "window", count, units)
    SELECT ?, ?, ?, ?, ? WHERE ${guard ? guard.sql : '1'}
    ON CONFLICT(scope, subject, "window") DO UPDATE SET count = count + excluded.count, units = units + excluded.units
    RETURNING count, units`).bind(scope, subject, window, delta, units, ...(guard?.params ?? []));
}

/** 只读当前计数的语句形态，供与其他语句合进同一个 `db.batch`；用 counterResult 读取，没有行时为 null */
export function counterReadStatement(env: Env, scope: string, subject: string, window: number): D1PreparedStatement {
  return env.db.prepare('SELECT count, units FROM rate_counters WHERE scope = ? AND subject = ? AND "window" = ?')
    .bind(scope, subject, window);
}

/** 读取 counterStatement / counterReadStatement 的批量结果；守卫未通过或没有行时返回 null */
export function counterResult(result: D1Result | undefined): CounterValue | null {
  const row = (result?.results?.[0] ?? null) as { count?: number; units?: number } | null;
  if (!row) return null;
  return { count: Number(row.count ?? 0), units: Number(row.units ?? 0) };
}

/**
 * 原子增减计数并返回新值。
 *
 * D1 的 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 在一条语句内完成读-改-写，
 * 并发请求不会互相覆盖；对比原先 KV 上的 get→+1→put（非原子 + 最长 60s 读缓存），
 * 被盗账号并发打十几个请求就能全部读到同一个旧计数从而整体放行。
 *
 * delta 可为负数，用于「先占额度、失败后回退」。
 */
export async function bumpCounter(
  env: Env,
  scope: string,
  subject: string,
  window: number,
  delta = 1,
  units = 0,
): Promise<CounterValue> {
  const row = counterResult(await counterStatement(env, scope, subject, window, delta, units).all());
  return { count: row?.count ?? delta, units: row?.units ?? units };
}

/** 一个带上限的计数；limit 为 0 表示不限（照常计数，不设守卫） */
export interface CounterLimit {
  scope: string;
  subject: string;
  window: number;
  limit: number;
}

/**
 * 一组计数一起占一格：各自守卫递增（已满的不再累加），返回每个计数是否已满。
 * 有已满的计数时，把这次在其他计数上占到的格子退回——被拒的请求不推高任何计数。
 * 不能把多个计数串成一个守卫链：后一条语句只看得到前一条递增后的值，
 * 「前一计数这次刚好占满」与「前一计数早已满、这次没占」读到的是同一个值。
 */
export async function reserveCounters(env: Env, items: CounterLimit[]): Promise<boolean[]> {
  const results = await env.db.batch(items.map((item) => reserveStatement(env, item)));
  const full = results.map((result) => counterResult(result) === null);
  if (full.some(Boolean)) {
    const taken = items.filter((_, index) => !full[index]);
    if (taken.length) await releaseCounters(env, taken);
  }
  return full;
}

/** 占一格的单条语句（已满时不递增、结果无行，counterResult 为 null），供调用方与自己的读语句合进同一个 batch */
export function reserveStatement(env: Env, item: CounterLimit): D1PreparedStatement {
  const guard = item.limit > 0 ? counterWithinGuard(item.scope, item.subject, item.window, item.limit - 1) : undefined;
  return counterStatement(env, item.scope, item.subject, item.window, 1, 0, guard);
}

/** 退回 reserveCounters 占到的格子（窗口用占位时的那个，跨窗口也不会退到新窗口上） */
export async function releaseCounters(env: Env, items: CounterLimit[]): Promise<void> {
  if (!items.length) return;
  await env.db.batch(items.map((item) => counterStatement(env, item.scope, item.subject, item.window, -1)));
}

/** 只读当前值（不递增），用于「超限则拒绝」之外的展示/判断 */
export async function readCounter(
  env: Env,
  scope: string,
  subject: string,
  window: number,
): Promise<CounterValue> {
  const db = createDb(env);
  const row = await db
    .select({ count: rateCounters.count, units: rateCounters.units })
    .from(rateCounters)
    .where(
      and(
        eq(rateCounters.scope, scope),
        eq(rateCounters.subject, subject),
        eq(rateCounters.window, window),
      ),
    )
    .get();
  return { count: row?.count ?? 0, units: row?.units ?? 0 };
}

/** 清理过期窗口行（由 scheduled 调用）；窗口单位相同的 scope 一起传，cutoff 按该单位计 */
export async function purgeCounters(env: Env, scopes: string | string[], beforeWindow: number): Promise<void> {
  const db = createDb(env);
  await db
    .delete(rateCounters)
    .where(and(inArray(rateCounters.scope, ([] as string[]).concat(scopes)), lt(rateCounters.window, beforeWindow)));
}
