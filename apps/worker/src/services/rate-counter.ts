import { and, eq, lt } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { rateCounters } from '../db/schema.js';
import type { Env } from '../types.js';

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

/** 读取 counterStatement 的批量结果；守卫未通过时返回 null */
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

/** 清理过期窗口行（由 scheduled 调用），按 scope 各自的窗口单位传 cutoff */
export async function purgeCounters(env: Env, scope: string, beforeWindow: number): Promise<void> {
  const db = createDb(env);
  await db
    .delete(rateCounters)
    .where(and(eq(rateCounters.scope, scope), lt(rateCounters.window, beforeWindow)));
}
