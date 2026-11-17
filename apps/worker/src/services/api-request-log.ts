import type { Env } from '../types.js';
import { API_REJECT_SCOPE, counterStatement, counterWithinGuard, minuteWindow } from './rate-counter.js';

export interface ApiRequestLogEntry {
  apiKeyId: number;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  ip: string;
  durationMs: number;
}

const COLUMNS = 'api_key_id, request_id, method, path, status_code, ip, duration_ms';

/** 成功的读请求：GET/HEAD 且 2xx 或 304（带 If-None-Match 的轮询命中 304 也是成功读取） */
function isSuccessfulRead(entry: ApiRequestLogEntry): boolean {
  if (entry.method !== 'GET' && entry.method !== 'HEAD') return false;
  return (entry.statusCode >= 200 && entry.statusCode < 300) || entry.statusCode === 304;
}

/**
 * /v1 请求日志，三种写法：
 * - 成功的读请求按（Key、方法、路由、状态码、分钟）聚合成一行：本分钟第一次插入，之后只给这一行累加
 *   request_count 与 duration_ms。高频轮询（同一批邮件详情反复拉取）原先每次请求插一行、写 4 个 B 树
 *  （表、两个索引、AUTOINCREMENT 的 sqlite_sequence），现在同一分钟内只改一行；requestId/ip/created_at
 *   保留该分钟第一次请求的值。
 * - 写操作与失败的放行请求逐条记录（排障要 requestId 与具体时间）。
 * - 中间件拒绝的请求先累加本 Key 本分钟的拒绝计数，同一事务里只有第一次拒绝写明细。
 */
export async function writeApiRequestLog(env: Env, admitted: boolean, entry: ApiRequestLogEntry): Promise<void> {
  const values = [entry.apiKeyId, entry.requestId, entry.method, entry.path, entry.statusCode, entry.ip, entry.durationMs];
  if (admitted && isSuccessfulRead(entry)) {
    const minute = Math.floor(Date.now() / 60_000);
    // 冲突目标带 WHERE 才能匹配部分唯一索引 idx_api_logs_minute（逐条记录的 minute 为 NULL，不进该索引）
    await env.db.prepare(`INSERT INTO api_request_logs (${COLUMNS}, minute, request_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (api_key_id, minute, method, path, status_code) WHERE minute IS NOT NULL
      DO UPDATE SET request_count = request_count + 1, duration_ms = duration_ms + excluded.duration_ms`)
      .bind(...values, minute).run();
    return;
  }
  if (admitted) {
    await env.db.prepare(`INSERT INTO api_request_logs (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(...values).run();
    return;
  }
  const subject = String(entry.apiKeyId);
  const window = minuteWindow(1);
  const firstReject = counterWithinGuard(API_REJECT_SCOPE, subject, window, 1);
  await env.db.batch([
    counterStatement(env, API_REJECT_SCOPE, subject, window),
    env.db.prepare(`INSERT INTO api_request_logs (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${firstReject.sql}`)
      .bind(...values, ...firstReject.params),
  ]);
}
