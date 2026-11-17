import type {
  AdminSuppressionsQuery,
  EmailSuppression,
  Page,
  SuppressedRecipient,
  SuppressionReason,
} from '@hpc-mail/shared';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, toPage } from '../lib/pagination.js';
import type { Env } from '../types.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 软退信（临时失败、重试耗尽）抑制 24 小时；与 Cloudflare 的默认一致 */
export const SOFT_BOUNCE_SUPPRESSION_MS = DAY;
/** 其他硬退信抑制 7 天；地址或域名不存在时长期有效 */
export const HARD_BOUNCE_SUPPRESSION_MS = 7 * DAY;
/** 地址或域名不存在（5.1.1 邮箱不存在、5.1.2 域名不存在、5.1.10 域名不收信）：不会自己恢复，长期抑制 */
const PERMANENT_ENHANCED_CODES = new Set(['5.1.1', '5.1.2', '5.1.10']);

export interface SuppressionRow {
  address: string;
  sending_domain: string;
  reason: SuppressionReason;
  expires_at: number | null;
  created_at: number;
}

/** 退信事件决定抑制原因与期限：硬退信 7 天（地址或域名不存在时长期），其余按软退信 24 小时 */
export function bounceSuppression(bounce: { type?: string; classification?: string } | undefined,
  smtpStatusCode: string | undefined, smtpEnhancedStatusCode: string | undefined, now: number,
): { reason: SuppressionReason; expiresAt: number | null } {
  const hard = bounce?.type === 'hard' || bounce?.classification === 'permanent_failure'
    || (!bounce?.type && (smtpStatusCode ?? '').startsWith('5'));
  if (!hard) return { reason: 'soft_bounce', expiresAt: now + SOFT_BOUNCE_SUPPRESSION_MS };
  const enhanced = (smtpEnhancedStatusCode ?? '').trim();
  return { reason: 'hard_bounce', expiresAt: PERMANENT_ENHANCED_CODES.has(enhanced) ? null : now + HARD_BOUNCE_SUPPRESSION_MS };
}

/**
 * 写入或续期一条抑制：期限取更长的一方（null 为长期），原因与说明跟随期限更长的事件；
 * 已过期的条目视为新进入名单，since 重新计时。
 */
export function upsertSuppressionStatement(env: Env, input: {
  address: string; sendingDomain: string; reason: SuppressionReason; detail: string; expiresAt: number | null;
  eventId: string; now: number;
}): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO email_suppressions (address, sending_domain, reason, detail, expires_at, event_id, updated_at, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT (address, sending_domain) DO UPDATE SET
      reason = CASE WHEN excluded.expires_at IS NULL OR (email_suppressions.expires_at IS NOT NULL
        AND excluded.expires_at >= email_suppressions.expires_at) THEN excluded.reason ELSE email_suppressions.reason END,
      detail = CASE WHEN excluded.expires_at IS NULL OR (email_suppressions.expires_at IS NOT NULL
        AND excluded.expires_at >= email_suppressions.expires_at) THEN excluded.detail ELSE email_suppressions.detail END,
      created_at = CASE WHEN email_suppressions.expires_at IS NOT NULL AND email_suppressions.expires_at <= ?7
        THEN excluded.created_at ELSE email_suppressions.created_at END,
      expires_at = CASE WHEN excluded.expires_at IS NULL OR email_suppressions.expires_at IS NULL THEN NULL
        ELSE max(excluded.expires_at, email_suppressions.expires_at) END,
      event_id = excluded.event_id,
      updated_at = excluded.updated_at`)
    .bind(input.address, input.sendingDomain, input.reason, input.detail.slice(0, 500), input.expiresAt, input.eventId, input.now);
}

/**
 * 发信前查询收件人在抑制名单里的有效条目（不分发信域名，调用方按发件域名筛选），可以与其他读取并行。
 * 查询失败只记日志、按没有抑制处理：Cloudflare 侧仍会拒发被它抑制的收件人。
 */
export async function lookupSuppressions(env: Env, addresses: string[]): Promise<SuppressionRow[]> {
  const unique = [...new Set(addresses)];
  if (!unique.length) return [];
  try {
    const now = Date.now();
    const statements = chunk(unique, 90).map(batch => env.db.prepare(`SELECT address, sending_domain, reason, expires_at, created_at
      FROM email_suppressions WHERE address IN (${batch.map(() => '?').join(', ')}) AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(...batch, now));
    const results = await env.db.batch<SuppressionRow>(statements);
    return results.flatMap(result => result.results);
  } catch (error) {
    console.error('抑制名单查询失败，按未抑制处理:', error);
    return [];
  }
}

function toSuppressed(row: SuppressionRow): SuppressedRecipient {
  return {
    address: row.address, reason: row.reason, sendingDomain: row.sending_domain,
    since: new Date(Number(row.created_at)).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(Number(row.expires_at)).toISOString(),
  };
}

/** 只保留对这个发件域名生效的条目，按收件地址索引 */
export function suppressedFor(rows: SuppressionRow[], sendingDomain: string): Map<string, SuppressedRecipient> {
  return new Map(rows.filter(row => row.sending_domain === sendingDomain).map(row => [row.address, toSuppressed(row)]));
}

const REASON_TEXT: Record<SuppressionReason, string> = {
  hard_bounce: '此前退信（地址或域名不可用）',
  soft_bounce: '此前临时退信且重试耗尽',
  complaint: '收件人曾把来信标记为垃圾邮件',
};

/** 单个收件人被抑制的说明，写进逐收件人结果的 error */
export function suppressionMessage(item: SuppressedRecipient): string {
  const until = item.expiresAt ? `，${item.expiresAt} 自动解除` : '，需管理员解除';
  return `收件人在 ${item.sendingDomain} 的抑制名单中：${REASON_TEXT[item.reason]}${until}`;
}

/** 全部收件人都被抑制：没有发信，也不占配额 */
export function recipientSuppressedError(items: SuppressedRecipient[]): AppError {
  return new AppError('recipient_suppressed', `全部收件人都在抑制名单中，没有发送：${items.map(item =>
    `${item.address}（${REASON_TEXT[item.reason]}）`).join('；')}`, {
    fix: '换用其他收件人；对方地址恢复后由管理员在抑制名单中解除（软退信 24 小时、一般硬退信 7 天后自动解除）',
    docs: '/references/errors.md#recipient_suppressed',
    details: { suppressed: items },
  });
}

interface SuppressionListRow extends SuppressionRow {
  id: number;
  detail: string;
  updated_at: number;
}

/** 管理员查看有效的抑制条目，按 id 倒序游标分页 */
export async function listSuppressions(env: Env, query: AdminSuppressionsQuery): Promise<Page<EmailSuppression>> {
  const before = decodeCursor(query.cursor);
  const conditions = ['(expires_at IS NULL OR expires_at > ?)'];
  const params: unknown[] = [Date.now()];
  if (before !== null) {
    conditions.push('id < ?');
    params.push(before);
  }
  if (query.q) {
    conditions.push("(instr(address, ?) > 0 OR instr(sending_domain, ?) > 0)");
    params.push(query.q.toLowerCase(), query.q.toLowerCase());
  }
  const { results } = await env.db.prepare(`SELECT id, address, sending_domain, reason, detail, expires_at, created_at, updated_at
    FROM email_suppressions WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .bind(...params, query.limit + 1).all<SuppressionListRow>();
  const page = toPage(results, query.limit, (row) => Number(row.id));
  return {
    items: page.items.map(row => ({ ...toSuppressed(row), id: Number(row.id), detail: row.detail,
      updatedAt: new Date(Number(row.updated_at)).toISOString() })),
    nextCursor: page.nextCursor,
  };
}

/** 解除一条抑制，返回被删条目（审计用）；不存在为 not_found */
export async function deleteSuppression(env: Env, id: number): Promise<{ address: string; sendingDomain: string }> {
  const row = await env.db.prepare('DELETE FROM email_suppressions WHERE id = ? RETURNING address, sending_domain')
    .bind(id).first<{ address: string; sending_domain: string }>();
  if (!row) throw new AppError('not_found', '抑制条目不存在或已解除');
  return { address: row.address, sendingDomain: row.sending_domain };
}

/** 每日维护：删除过期一天以上的条目 */
export async function cleanupExpiredSuppressions(env: Env): Promise<number> {
  const result = await env.db.prepare(`DELETE FROM email_suppressions WHERE id IN (SELECT id FROM email_suppressions
    WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 1000)`).bind(Date.now() - DAY).run();
  return result.meta.changes ?? 0;
}
