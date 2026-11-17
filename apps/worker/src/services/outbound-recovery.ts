import { OUTBOUND_PENDING_STALE_MS, type MessageRecipients, type RecipientOutcome } from '@hpc-mail/shared';
import type { Env } from '../types.js';

/** 每轮最多处理的中断外发数 */
const STALE_OUTBOUND_BATCH = 100;
export const UNKNOWN_OUTCOME_ERROR = '投递中断，结果未确认';

/**
 * 方向与状态写成字面量，规划器才能确认命中 idx_messages_outbound_pending 部分索引，只扫 pending 外发
 * （导出供 EXPLAIN 回归）
 */
export const STALE_OUTBOUND_SQL = `SELECT id, recipients, recipient_outcomes FROM messages
  WHERE direction = 'outbound' AND status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?`;

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/**
 * 投递中断（Worker 在投递中途被回收、最终结果回填两次都失败）的外发会一直停在 pending，同 Key 重放永远 409。
 * 超过 OUTBOUND_PENDING_STALE_MS 仍是 pending 的标为 unknown：保留已经回填的逐收件人结果，缺的目标补 unknown，
 * 可能已经送达，补发前要先向收件人确认。
 */
export async function markStaleOutbound(env: Env, now = Date.now(), limit = STALE_OUTBOUND_BATCH): Promise<number> {
  const rows = (await env.db.prepare(STALE_OUTBOUND_SQL).bind(now - OUTBOUND_PENDING_STALE_MS, limit)
    .all<{ id: number; recipients: string; recipient_outcomes: string }>()).results;
  if (!rows.length) return 0;
  const statements = rows.map((row) => {
    const recipients = parseJson<Partial<MessageRecipients>>(row.recipients, {});
    const recorded = parseJson<RecipientOutcome[]>(row.recipient_outcomes, []);
    const known = new Set(recorded.map((outcome) => outcome.address));
    const missing = [...new Set([...recipients.to ?? [], ...recipients.cc ?? [], ...recipients.bcc ?? []])]
      .filter((address) => !known.has(address));
    const outcomes: RecipientOutcome[] = [
      ...recorded,
      ...missing.map((address) => ({ address, status: 'unknown' as const, error: UNKNOWN_OUTCOME_ERROR })),
    ];
    const failed = recorded.filter((outcome) => outcome.status === 'failed')
      .map((outcome) => `${outcome.address}: ${outcome.error ?? ''}`);
    const errorDetail = `${UNKNOWN_OUTCOME_ERROR}${missing.length ? `: ${missing.join(', ')}` : ''}` +
      (failed.length ? `；已失败: ${failed.join('; ')}` : '');
    return env.db.prepare(`UPDATE messages SET status = 'unknown', recipient_outcomes = ?, error_detail = ?
      WHERE id = ? AND status = 'pending'`).bind(JSON.stringify(outcomes), errorDetail, row.id);
  });
  const results = await env.db.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
