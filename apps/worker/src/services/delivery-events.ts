import { DELIVERY_EVENT_TYPES, type DeliveryEventType, type RecipientOutcome } from '@hpc-mail/shared';
import { chunk } from '../lib/d1.js';
import { getEmailDomain } from '../lib/email-address.js';
import type { Env, ExecCtx } from '../types.js';
import { bounceSuppression, upsertSuppressionStatement } from './suppression.js';

/**
 * Cloudflare Email Sending 投递事件（Queue 消息体）。只信任用到的字段，其余忽略。
 * https://developers.cloudflare.com/email-service/reference/event-subscriptions/
 */
interface RawEvent {
  type?: unknown;
  payload?: {
    eventId?: unknown; messageId?: unknown; sender?: unknown; recipient?: unknown;
    delivery?: { smtpStatusCode?: unknown; smtpEnhancedStatusCode?: unknown; smtpResponse?: unknown };
    bounce?: { type?: unknown; classification?: unknown; reason?: unknown };
    failure?: { reason?: unknown };
    rejection?: { reason?: unknown; detail?: unknown };
  };
  metadata?: { eventTimestamp?: unknown };
}

export interface DeliveryEvent {
  type: DeliveryEventType;
  eventId: string;
  messageId: string;
  sender: string;
  recipient: string;
  /** 事件发生时间（毫秒） */
  at: number;
  smtpStatus: string;
  /** 失败类事件的原因（写进逐收件人结果的 error）；delivered/complained 为空串 */
  error: string;
  /** 退信的抑制原因与期限；只有 bounced 有 */
  bounce?: { type?: string; classification?: string };
  smtpStatusCode?: string;
  smtpEnhancedStatusCode?: string;
}

const TYPE_PATTERN = new RegExp(`^cf\\.email\\.sending\\.message\\.(${DELIVERY_EVENT_TYPES.join('|')})$`);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const clip = (value: string, max = 300): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** 校验并规整一条事件；不是本站订阅的终态事件或缺少关键字段时返回 null */
export function parseDeliveryEvent(body: unknown, now = Date.now()): DeliveryEvent | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as RawEvent;
  const match = TYPE_PATTERN.exec(str(raw.type));
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : null;
  if (!match || !payload) return null;
  const type = match[1] as DeliveryEventType;
  const recipient = str(payload.recipient).toLowerCase();
  const sender = str(payload.sender).toLowerCase();
  if (!recipient.includes('@') || !sender.includes('@')) return null;
  const delivery = payload.delivery ?? {};
  const smtpStatusCode = str(delivery.smtpStatusCode);
  const smtpEnhancedStatusCode = str(delivery.smtpEnhancedStatusCode);
  const timestamp = Date.parse(str(raw.metadata?.eventTimestamp));
  let error = '';
  if (type === 'bounced') error = str(delivery.smtpResponse) || str(payload.bounce?.reason) || '收件服务器退信';
  else if (type === 'failed') error = `Cloudflare 投递失败（${str(payload.failure?.reason) || '未说明原因'}）`;
  else if (type === 'rejected') {
    const detail = str(payload.rejection?.detail);
    error = `Cloudflare 拒绝投递（${str(payload.rejection?.reason) || '未说明原因'}${detail ? `：${detail}` : ''}）`;
  }
  return {
    type, eventId: clip(str(payload.eventId), 100), messageId: clip(str(payload.messageId), 200), sender, recipient,
    at: Number.isFinite(timestamp) ? timestamp : now,
    smtpStatus: [smtpStatusCode, smtpEnhancedStatusCode].filter(Boolean).join(' '),
    error: clip(error),
    ...(type === 'bounced' ? { bounce: { type: str(payload.bounce?.type), classification: str(payload.bounce?.classification) } } : {}),
    smtpStatusCode, smtpEnhancedStatusCode,
  };
}

// ---------------------------------------------------------------------------
// 发送时登记对应关系

export interface DeliveryRefInput {
  kind: 'message' | 'forward';
  messageId: number;
  sender: string;
  /** 本站写进原文的 Message-ID（可带尖括号）；中转转发没有 */
  rfcMessageId: string | null;
  /** forward：结果归属人 */
  ownerIds?: number[];
  targets: { recipient: string; providerMessageId: string | null }[];
}

const stripBrackets = (value: string): string => value.trim().replace(/^<|>$/g, '');

/** 每个外部收件人一行；与发件结果写在同一个 batch 里，不多一次往返 */
export function deliveryRefStatements(env: Env, input: DeliveryRefInput): D1PreparedStatement[] {
  const now = Date.now();
  const rfc = input.rfcMessageId ? stripBrackets(input.rfcMessageId) : null;
  const owners = JSON.stringify(input.ownerIds ?? []);
  // 每行 8 个绑定，10 行一条语句，不超过 D1 的 100 参数上限
  return chunk(input.targets, 10).map((rows) => env.db.prepare(`INSERT OR IGNORE INTO email_delivery_refs
      (provider_message_id, rfc_message_id, kind, message_id, sender, recipient, owner_ids, created_at)
      VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
    .bind(...rows.flatMap((row) => [row.providerMessageId || null, rfc, input.kind, input.messageId,
      input.sender.toLowerCase(), row.recipient.toLowerCase(), owners, now])));
}

/** 中转转发成功后登记（在 waitUntil 里，失败只记日志） */
export async function saveDeliveryRefs(env: Env, input: DeliveryRefInput): Promise<void> {
  if (!input.targets.length) return;
  try { await env.db.batch(deliveryRefStatements(env, input)); }
  catch (error) { console.error('投递回执对应关系保存失败:', error); }
}

// ---------------------------------------------------------------------------
// 消费事件

interface RefRow {
  id: number;
  kind: 'message' | 'forward';
  message_id: number;
  recipient: string;
  owner_ids: string;
}

interface MessageRow {
  id: number;
  address: string;
  status: string;
  recipient_outcomes: string;
}

export type DeliveryEventResult = 'applied' | 'unchanged' | 'ignored' | 'unmatched' | 'retry';

/** 投递结果事件推给发件人（Webhook v2）；processDeliveryEvent 只收集，由消费者统一发出 */
export interface DeliveryUserEvent {
  userId: number;
  event: 'mail.delivered' | 'mail.bounced';
  data: {
    messageId: number; address: string; recipient: string; status: RecipientOutcome['status'];
    deliveryEvent: DeliveryEventType; smtpStatus: string; error: string; occurredAt: string;
  };
}

/** 事件早于发件结果落库（还在 pending）或对应关系还没写入时的重试：只在事件很新时等，最多 4 次 */
const MATCH_GRACE_MS = 15 * 60_000;
const MAX_MATCH_ATTEMPTS = 4;
const OUTCOME_FROM_EVENT: Record<DeliveryEventType, RecipientOutcome['status']> = {
  delivered: 'delivered', bounced: 'bounced', failed: 'failed', rejected: 'failed', complained: 'complained',
};
const SUCCEEDED = new Set<RecipientOutcome['status']>(['delivered', 'sent', 'complained', 'unknown']);

/** 发件整体状态与 errorDetail：与 sendMail 写最终结果的口径一致 */
export function summarizeOutcomes(outcomes: RecipientOutcome[]): { status: 'sent' | 'delivered' | 'failed'; errorDetail: string } {
  const succeeded = outcomes.filter((outcome) => SUCCEEDED.has(outcome.status));
  const status = !succeeded.length ? 'failed' : outcomes.some((outcome) => outcome.status === 'sent') ? 'sent' : 'delivered';
  const errors = outcomes.filter((outcome) => outcome.error).map((outcome) => `${outcome.address}: ${outcome.error}`);
  const errorDetail = !errors.length ? '' : succeeded.length
    ? `部分收件人失败: ${errors.join('; ')}` : `全部收件人投递失败: ${errors.join('; ')}`;
  return { status, errorDetail: errorDetail.slice(0, 2000) };
}

/** 把事件应用到一个收件人的结果；比已有回执旧或完全相同的事件不改动，返回 null */
export function applyEventToOutcome(outcome: RecipientOutcome, event: DeliveryEvent): RecipientOutcome | null {
  // 站内收件人与本站拦下的收件人没有发往 Cloudflare，不会有真实回执
  if (outcome.code === 'recipient_suppressed') return null;
  if (outcome.eventAt) {
    const previous = Date.parse(outcome.eventAt);
    if (previous > event.at || (previous === event.at && outcome.event === event.type)) return null;
  }
  const next: RecipientOutcome = {
    address: outcome.address, status: OUTCOME_FROM_EVENT[event.type],
    event: event.type, eventAt: new Date(event.at).toISOString(),
  };
  if (event.error) next.error = event.error;
  if (event.smtpStatus) next.smtpStatus = event.smtpStatus;
  return next;
}

async function findRef(env: Env, event: DeliveryEvent, suppression: D1PreparedStatement | null): Promise<RefRow | null> {
  const columns = 'SELECT id, kind, message_id, recipient, owner_ids FROM email_delivery_refs';
  const statements = [
    ...(suppression ? [suppression] : []),
    env.db.prepare(`${columns} WHERE provider_message_id = ? LIMIT 1`).bind(event.messageId),
    env.db.prepare(`${columns} WHERE rfc_message_id = ? AND recipient = ? ORDER BY id DESC LIMIT 1`)
      .bind(stripBrackets(event.messageId), event.recipient),
    // 兜底：同一发件人发给同一收件人、还没有回执的只有一条时才认定（多条时无法分辨，宁可不回写）
    env.db.prepare(`${columns} INDEXED BY idx_delivery_refs_pending_pair
      WHERE recipient = ? AND sender = ? AND resolved_at IS NULL AND created_at >= ? ORDER BY id LIMIT 2`)
      .bind(event.recipient, event.sender, event.at - 3 * 86_400_000),
  ];
  const results = await env.db.batch<RefRow>(statements);
  const [byProvider, byRfc, byPair] = results.slice(suppression ? 1 : 0).map((result) => result.results);
  if (event.messageId && byProvider?.[0]) return byProvider[0];
  if (event.messageId && byRfc?.[0]) return byRfc[0];
  return event.type !== 'complained' && byPair?.length === 1 ? byPair[0]! : null;
}

const resolveRef = (env: Env, id: number, at: number) =>
  env.db.prepare('UPDATE email_delivery_refs SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').bind(at, id);

/** 回写一个发件行；并发写入用旧值做条件，冲突时重读重试 */
async function applyToMessage(env: Env, ref: RefRow, event: DeliveryEvent, attempts: number,
  userEvents: DeliveryUserEvent[]): Promise<DeliveryEventResult> {
  for (let round = 0; round < 3; round++) {
    const [messageResult, ownerResult] = await env.db.batch([
      env.db.prepare(`SELECT id, address, status, recipient_outcomes FROM messages
        WHERE id = ? AND direction = 'outbound'`).bind(ref.message_id),
      env.db.prepare(`SELECT user_id FROM mailboxes WHERE address = (SELECT address FROM messages WHERE id = ?)`)
        .bind(ref.message_id),
    ]);
    const message = (messageResult!.results as MessageRow[])[0];
    if (!message) {
      await resolveRef(env, ref.id, event.at).run();
      return 'ignored';
    }
    // 发件结果还没落库：稍后重投，避免最终结果覆盖回执
    if (message.status === 'pending') return attempts < MAX_MATCH_ATTEMPTS ? 'retry' : 'ignored';
    let outcomes: RecipientOutcome[];
    try { outcomes = JSON.parse(message.recipient_outcomes) as RecipientOutcome[]; } catch { return 'ignored'; }
    const index = outcomes.findIndex((outcome) => outcome.address.toLowerCase() === ref.recipient);
    const updated = index >= 0 ? applyEventToOutcome(outcomes[index]!, event) : null;
    if (!updated) {
      await resolveRef(env, ref.id, event.at).run();
      return 'unchanged';
    }
    const nextOutcomes = outcomes.map((outcome, i) => (i === index ? updated : outcome));
    // unknown 行保留原状态（其他收件人仍未确认），只更新这个收件人的结果
    const summary = message.status === 'unknown' ? null : summarizeOutcomes(nextOutcomes);
    const [write] = await env.db.batch([
      env.db.prepare(`UPDATE messages SET recipient_outcomes = ?, status = COALESCE(?, status), error_detail = COALESCE(?, error_detail)
        WHERE id = ? AND recipient_outcomes = ? AND status = ?`)
        .bind(JSON.stringify(nextOutcomes), summary?.status ?? null, summary?.errorDetail ?? null,
          message.id, message.recipient_outcomes, message.status),
      resolveRef(env, ref.id, event.at),
    ]);
    if (!write!.meta.changes) continue;
    const ownerId = (ownerResult!.results as { user_id: number }[])[0]?.user_id;
    if (ownerId && event.type !== 'complained') {
      userEvents.push({
        userId: Number(ownerId), event: event.type === 'delivered' ? 'mail.delivered' : 'mail.bounced',
        data: { messageId: message.id, address: message.address, recipient: ref.recipient, status: updated.status,
          deliveryEvent: event.type, smtpStatus: event.smtpStatus, error: event.error, occurredAt: updated.eventAt! },
      });
    }
    return 'applied';
  }
  return 'retry';
}

/** 中转转发的最终失败：成功记录改为失败，网页通知健康与（PR4a 之后的）/v1 通知读取都能看到 */
async function applyToForward(env: Env, ref: RefRow, event: DeliveryEvent): Promise<DeliveryEventResult> {
  const statements = [resolveRef(env, ref.id, event.at)];
  const failed = event.type === 'bounced' || event.type === 'failed' || event.type === 'rejected';
  if (failed) {
    let owners: number[] = [];
    try { owners = (JSON.parse(ref.owner_ids) as unknown[]).filter((id): id is number => Number.isInteger(id)); } catch { /* 无归属人 */ }
    const keys = owners.map((userId) => `mail:${ref.message_id}:${userId}:forward:${ref.recipient}`);
    if (keys.length) {
      statements.push(env.db.prepare(`UPDATE notification_jobs SET status = 'failed', last_error = ?, updated_at = ?
        WHERE dedupe_key IN (${keys.map(() => '?').join(', ')}) AND status = 'succeeded' AND forward_mode = 'relay'`)
        .bind(`Cloudflare 侧最终投递失败：${event.smtpStatus ? `${event.smtpStatus} ` : ''}${event.error}`.slice(0, 300), Date.now(), ...keys));
    }
  }
  const results = await env.db.batch(statements);
  return failed && results[1]?.meta.changes ? 'applied' : 'unchanged';
}

/**
 * 处理一条事件：退信与投诉先进抑制名单（与查找对应关系同一往返），再回写发件行或转发任务。
 * 返回 retry 时由调用方延迟重投；其他结果都确认消息。
 */
export async function processDeliveryEvent(env: Env, body: unknown,
  options: { attempts?: number; now?: number; userEvents?: DeliveryUserEvent[] } = {}): Promise<DeliveryEventResult> {
  const now = options.now ?? Date.now();
  const event = parseDeliveryEvent(body, now);
  if (!event) return 'ignored';
  const sendingDomain = getEmailDomain(event.sender);
  let suppression: D1PreparedStatement | null = null;
  if (event.type === 'complained') {
    suppression = upsertSuppressionStatement(env, { address: event.recipient, sendingDomain, reason: 'complaint',
      detail: '收件人把来信标记为垃圾邮件', expiresAt: null, eventId: event.eventId, now });
  } else if (event.type === 'bounced') {
    const rule = bounceSuppression(event.bounce, event.smtpStatusCode, event.smtpEnhancedStatusCode, event.at);
    suppression = upsertSuppressionStatement(env, { address: event.recipient, sendingDomain, reason: rule.reason,
      detail: [event.smtpStatus, event.error].filter(Boolean).join(' '), expiresAt: rule.expiresAt, eventId: event.eventId, now });
  }
  const ref = await findRef(env, event, suppression);
  const attempts = options.attempts ?? 1;
  if (!ref) {
    // 对应关系与发件结果在同一个 batch 写入：事件比它先到时稍后再找；旧事件或别处发出的邮件直接确认
    return now - event.at < MATCH_GRACE_MS && attempts < MAX_MATCH_ATTEMPTS ? 'retry' : 'unmatched';
  }
  if (ref.kind === 'forward') return applyToForward(env, ref, event);
  return applyToMessage(env, ref, event, attempts, options.userEvents ?? []);
}

/**
 * Webhook v2 的接入点：PR4a 的 emitUserEvent(env, userId, event, ctx) 合入后在这里调用。
 * TODO(PR4a)：for (const item of events) await emitUserEvent(env, item.userId, { type: item.event, data: item.data }, ctx);
 */
export async function emitDeliveryUserEvents(_env: Env, _ctx: ExecCtx, _events: DeliveryUserEvent[]): Promise<void> {
  // PR4a 合入前不推送
}

/** Queue consumer：逐条处理，数据库故障或需要等待时延迟重投，其余确认；每批输出一行汇总日志 */
export async function handleDeliveryEventBatch(batch: MessageBatch<unknown>, env: Env, ctx: ExecCtx): Promise<void> {
  const counts: Record<DeliveryEventResult | 'error', number> = { applied: 0, unchanged: 0, ignored: 0, unmatched: 0, retry: 0, error: 0 };
  const userEvents: DeliveryUserEvent[] = [];
  for (const message of batch.messages) {
    try {
      const result = await processDeliveryEvent(env, message.body, { attempts: message.attempts, userEvents });
      counts[result]++;
      if (result === 'retry') message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch (error) {
      counts.error++;
      console.error('投递事件处理失败，稍后重试:', error);
      message.retry({ delaySeconds: 30 });
    }
  }
  if (userEvents.length) {
    ctx.waitUntil(emitDeliveryUserEvents(env, ctx, userEvents).catch((error) => console.error('投递结果事件推送失败:', error)));
  }
  console.log(JSON.stringify({ event: 'delivery_events', queue: batch.queue, size: batch.messages.length, ...counts }));
}

/** 每日维护：删除 30 天前的对应关系（事件不会晚这么久到达） */
export async function cleanupDeliveryRefs(env: Env): Promise<number> {
  const result = await env.db.prepare(`DELETE FROM email_delivery_refs WHERE id IN (SELECT id FROM email_delivery_refs
    WHERE created_at < ? LIMIT 5000)`).bind(Date.now() - 30 * 86_400_000).run();
  return result.meta.changes ?? 0;
}
