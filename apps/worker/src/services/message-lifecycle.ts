import { sql, type SQL } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { Env } from '../types.js';
import { processStorageCleanup } from './storage-cleanup.js';

/** All metadata removal and garbage references commit together, before awaiting R2. */
export function purgeStatements(env: Env, token: string): D1PreparedStatement[] {
  const selected = 'SELECT id FROM messages WHERE purge_token = ?';
  return [
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
      SELECT r2_key FROM attachments WHERE message_id IN (${selected})
      UNION SELECT body_r2_key FROM messages WHERE purge_token = ? AND body_r2_key IS NOT NULL
      UNION SELECT raw_r2_key FROM messages WHERE purge_token = ? AND raw_r2_key IS NOT NULL`).bind(token, token, token),
    env.db.prepare(`DELETE FROM attachments WHERE message_id IN (${selected})`).bind(token),
    env.db.prepare(`DELETE FROM stars WHERE message_id IN (${selected})`).bind(token),
    env.db.prepare('DELETE FROM messages WHERE purge_token = ?').bind(token),
  ];
}

export async function purgeMatchingMessages(env: Env, condition: SQL, limit = 1000): Promise<number> {
  const db = createDb(env);
  const token = crypto.randomUUID();
  // UPDATE re-evaluates ownership/retention/deleted state at the write boundary.
  const reservation = db.update(messages).set({ purgeToken: token }).where(sql`${messages.id} IN
    (SELECT id FROM ${messages} WHERE ${condition} LIMIT ${limit})`).toSQL();
  const results = await env.db.batch([
    env.db.prepare(reservation.sql).bind(...reservation.params), ...purgeStatements(env, token),
  ]);
  const deleted = results[4]?.meta.changes ?? 0;
  await processStorageCleanup(env, 100);
  return deleted;
}
