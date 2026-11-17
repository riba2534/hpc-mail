import { sql, type SQL } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { Env, ExecCtx } from '../types.js';
import { harvestPurgeStatement } from './claude-facts.js';
import { scheduleStorageCleanup } from './storage-cleanup.js';

/** purgeStatements 里删除 messages 行那条语句的下标；调用方据此读取实际删除条数 */
export const PURGE_MESSAGES_INDEX = 6;

/** All metadata removal and garbage references commit together, before awaiting R2. */
export function purgeStatements(env: Env, token: string): D1PreparedStatement[] {
  const selected = 'SELECT id FROM messages WHERE purge_token = ?';
  return [
    // 先把要删的官方 Claude 来信归纳进地址事实，邮件删掉后后缀统计不丢
    harvestPurgeStatement(env, token),
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
      SELECT r2_key FROM attachments WHERE message_id IN (${selected})
      UNION SELECT body_r2_key FROM messages WHERE purge_token = ? AND body_r2_key IS NOT NULL
      UNION SELECT raw_r2_key FROM messages WHERE purge_token = ? AND raw_r2_key IS NOT NULL`).bind(token, token, token),
    env.db.prepare(`DELETE FROM attachments WHERE message_id IN (${selected})`).bind(token),
    env.db.prepare(`DELETE FROM stars WHERE message_id IN (${selected})`).bind(token),
    // 译文是邮件内容的派生副本，必须随邮件一起删除
    env.db.prepare(`DELETE FROM message_translations WHERE message_id IN (${selected})`).bind(token),
    // 通知载荷含主题、验证码、链接与正文前 4000 字，同属派生副本；任务行保留供通知健康页查看。
    // message_id 无索引，按 dedupe_key 的 'mail:{id}:' 前缀走唯一索引做范围查找（';' 是 ':' 的下一个字符）；
    // CROSS JOIN 固定先按 purge_token 取邮件、再逐封查任务
    env.db.prepare(`UPDATE notification_jobs SET payload = '{}' WHERE payload <> '{}' AND id IN (
      SELECT j.id FROM messages m CROSS JOIN notification_jobs j
      WHERE m.purge_token = ? AND j.dedupe_key >= 'mail:' || m.id || ':' AND j.dedupe_key < 'mail:' || m.id || ';')`).bind(token),
    env.db.prepare('DELETE FROM messages WHERE purge_token = ?').bind(token),
  ];
}

/** 传入 ctx 时 R2 清理放进 waitUntil，不阻塞响应；不传时同步完成（cron 等没有请求的路径）。 */
export async function purgeMatchingMessages(env: Env, condition: SQL, limit = 1000, ctx?: ExecCtx | null): Promise<number> {
  const db = createDb(env);
  const token = crypto.randomUUID();
  // UPDATE re-evaluates ownership/retention/deleted state at the write boundary.
  const reservation = db.update(messages).set({ purgeToken: token }).where(sql`${messages.id} IN
    (SELECT id FROM ${messages} WHERE ${condition} LIMIT ${limit})`).toSQL();
  const results = await env.db.batch([
    env.db.prepare(reservation.sql).bind(...reservation.params), ...purgeStatements(env, token),
  ]);
  const deleted = results[1 + PURGE_MESSAGES_INDEX]?.meta.changes ?? 0;
  await scheduleStorageCleanup(env, ctx, 100);
  return deleted;
}
