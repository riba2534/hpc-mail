import {
  MAX_WEBHOOK_ENDPOINTS_PER_USER,
  WEBHOOK_BODY_MAX_CHARS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TEST_EVENT_TYPE,
  type CreatedWebhookEndpoint,
  type CreateWebhookEndpointRequest,
  type MessageRecipients,
  type Page,
  type RecipientOutcome,
  type UpdateWebhookEndpointRequest,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEventType,
  type WebhookTestResult,
} from '@hpc-mail/shared';
import { bytesToHex } from '../lib/crypto.js';
import { getEmailDomain, normalizeEmail } from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { PREVIEW_LIMIT } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { resolveVerificationCode } from './code-extract.js';
import { getDomains } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { NotificationDeliveryError, notificationRequest } from './notification-http.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { sendPushDeerNotification } from './pushdeer.js';
import { getJson } from './storage.js';
import { svixHeaders, validateNotifyWebhookUrl } from './webhook-notify.js';

/** 发给某个用户的 Webhook v2 事件 */
export interface UserEvent {
  type: WebhookEventType;
  /** 去重键：同一用户同一事件只投递一次，如 `mail.sent:123`、`hosted_domain.activated:7:<checkedAt>` */
  key: string;
  /** 事件 data（请求体为 { id, type, timestamp, data }） */
  data: Record<string, unknown>;
  /** 事件涉及的本站地址与域名，用于端点的 addresses / domains 过滤 */
  address?: string;
  domain?: string;
}

/** 第 n 次尝试失败后到下一次尝试的间隔：首次 + 7 次重试共 8 次，跨度约一天半 */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 10 * 3_600_000];
/** processing 超过这么久仍未写回结果（Worker 被回收）：放回 pending 重试。接收端按 webhook-id 去重 */
const PROCESSING_LEASE_MS = 2 * 60_000;
const SOURCE_GONE = '源邮件已永久删除，不再投递';
const ENDPOINT_GONE = '端点已停用或删除，不再投递';
const USER_AGENT = 'HPC-Mail-Webhooks/1.0';

interface EndpointRow {
  id: number;
  user_id: number;
  url: string;
  description: string;
  secret: string;
  events: string;
  addresses: string;
  domains: string;
  include_body: number;
  status: 'active' | 'disabled';
  disabled_reason: string;
  consecutive_failures: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: number;
  endpoint_id: number;
  user_id: number;
  event_id: string;
  event_type: string;
  event_key: string;
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  last_attempt_at: number | null;
  last_error: string;
  last_http_status: number | null;
  created_at: number;
}

const iso = (value: number | null) => (value === null ? null : new Date(Number(value)).toISOString());

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: Number(row.id), url: row.url, description: row.description,
    events: JSON.parse(row.events) as WebhookEventType[],
    addresses: JSON.parse(row.addresses) as string[], domains: JSON.parse(row.domains) as string[],
    includeBody: Boolean(row.include_body), status: row.status, disabledReason: row.disabled_reason,
    consecutiveFailures: Number(row.consecutive_failures),
    lastSuccessAt: iso(row.last_success_at), lastFailureAt: iso(row.last_failure_at),
    secretPrefix: row.secret.slice(0, 10), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: Number(row.id), endpointId: Number(row.endpoint_id), eventId: row.event_id, eventType: row.event_type as WebhookEventType,
    status: row.status, attempts: Number(row.attempts), maxAttempts: Math.max(WEBHOOK_MAX_ATTEMPTS, Number(row.attempts)),
    nextAttemptAt: row.status === 'pending' ? iso(row.next_attempt_at) : null, lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error, lastHttpStatus: row.last_http_status === null ? null : Number(row.last_http_status),
    createdAt: iso(row.created_at)!,
  };
}

function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

export function newEventId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `evt_${bytesToHex(bytes)}`;
}

/**
 * 端点 URL：必须 https、不带用户名密码、不是内网/保留地址/元数据地址（与通用 Webhook 同一规则），
 * 也不能指向本站：请求来源的主机、site_origin 与系统域名（含子域名）。
 */
export async function validateWebhookEndpointUrl(env: Env, raw: string, requestOrigin?: string): Promise<string> {
  const url = validateNotifyWebhookUrl(raw);
  if (!url) throw new AppError('validation_failed', 'Webhook 地址必须是 https 公网地址，不能是内网、保留或元数据地址，也不能带用户名密码');
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  const own = [requestOrigin, env.site_origin].flatMap((value) => {
    try { return value ? [new URL(value).hostname.toLowerCase()] : []; } catch { return []; }
  });
  const domains = await getDomains(env);
  if (own.includes(host) || domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new AppError('validation_failed', 'Webhook 地址不能指向本站');
  }
  return url.toString();
}

// ———————————————————————— 端点管理 ————————————————————————

async function loadEndpoint(env: Env, userId: number, id: number): Promise<EndpointRow> {
  const row = await env.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND user_id = ?').bind(id, userId).first<EndpointRow>();
  if (!row) throw new AppError('not_found', 'Webhook 端点不存在');
  return row;
}

export async function listWebhookEndpoints(env: Env, userId: number): Promise<WebhookEndpoint[]> {
  const { results } = await env.db.prepare('SELECT * FROM webhook_endpoints WHERE user_id = ? ORDER BY id').bind(userId).all<EndpointRow>();
  return results.map(toEndpoint);
}

export async function getWebhookEndpoint(env: Env, userId: number, id: number): Promise<WebhookEndpoint> {
  return toEndpoint(await loadEndpoint(env, userId, id));
}

export async function createWebhookEndpoint(env: Env, userId: number, req: CreateWebhookEndpointRequest, requestOrigin?: string): Promise<CreatedWebhookEndpoint> {
  const url = await validateWebhookEndpointUrl(env, req.url, requestOrigin);
  const secret = newSecret();
  const now = Date.now();
  const row = await env.db.prepare(`INSERT INTO webhook_endpoints
      (user_id, url, description, secret, events, addresses, domains, include_body, status, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
    WHERE (SELECT COUNT(*) FROM webhook_endpoints WHERE user_id = ?) < ?
    RETURNING *`).bind(userId, url, req.description, secret, JSON.stringify(req.events), JSON.stringify(req.addresses),
    JSON.stringify(req.domains), req.includeBody ? 1 : 0, now, now, userId, MAX_WEBHOOK_ENDPOINTS_PER_USER).first<EndpointRow>();
  if (!row) throw new AppError('forbidden', `每个用户最多 ${MAX_WEBHOOK_ENDPOINTS_PER_USER} 个 Webhook 端点`);
  return { ...toEndpoint(row), secret };
}

export async function updateWebhookEndpoint(
  env: Env, userId: number, id: number, req: UpdateWebhookEndpointRequest, requestOrigin?: string,
): Promise<WebhookEndpoint> {
  const current = await loadEndpoint(env, userId, id);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); values.push(value); };
  if (req.url !== undefined) set('url', await validateWebhookEndpointUrl(env, req.url, requestOrigin));
  if (req.description !== undefined) set('description', req.description);
  if (req.events !== undefined) set('events', JSON.stringify(req.events));
  if (req.addresses !== undefined) set('addresses', JSON.stringify(req.addresses));
  if (req.domains !== undefined) set('domains', JSON.stringify(req.domains));
  if (req.includeBody !== undefined) set('include_body', req.includeBody ? 1 : 0);
  if (req.enabled === true) {
    set('status', 'active'); set('disabled_reason', ''); set('consecutive_failures', 0);
  } else if (req.enabled === false) {
    set('status', 'disabled'); set('disabled_reason', '');
  }
  set('updated_at', Date.now());
  const row = await env.db.prepare(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = ? AND user_id = ? RETURNING *`)
    .bind(...values, current.id, userId).first<EndpointRow>();
  if (!row) throw new AppError('not_found', 'Webhook 端点不存在');
  return toEndpoint(row);
}

export async function deleteWebhookEndpoint(env: Env, userId: number, id: number): Promise<void> {
  await loadEndpoint(env, userId, id);
  await env.db.batch([
    env.db.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id = ? AND user_id = ?').bind(id, userId),
    env.db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND user_id = ?').bind(id, userId),
  ]);
}

/** 换新签名密钥，立即生效；完整密钥只在这次返回 */
export async function rotateWebhookSecret(env: Env, userId: number, id: number): Promise<CreatedWebhookEndpoint> {
  const secret = newSecret();
  const row = await env.db.prepare('UPDATE webhook_endpoints SET secret = ?, updated_at = ? WHERE id = ? AND user_id = ? RETURNING *')
    .bind(secret, Date.now(), id, userId).first<EndpointRow>();
  if (!row) throw new AppError('not_found', 'Webhook 端点不存在');
  return { ...toEndpoint(row), secret };
}

export async function listWebhookDeliveries(
  env: Env, userId: number, id: number, cursor: string | undefined, limit: number,
): Promise<Page<WebhookDelivery>> {
  await loadEndpoint(env, userId, id);
  const before = decodeCursor(cursor);
  const { results } = await env.db.prepare(`SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ${before ? 'AND id < ?' : ''}
    ORDER BY id DESC LIMIT ?`).bind(id, ...(before ? [before] : []), limit + 1).all<DeliveryRow>();
  const page = results.slice(0, limit);
  return { items: page.map(toDelivery), nextCursor: results.length > limit ? encodeCursor(Number(page[page.length - 1]!.id)) : null };
}

/** 手动重试一条已失败的投递：只发一次，端点必须是启用状态 */
export async function retryWebhookDelivery(env: Env, userId: number, endpointId: number, deliveryId: number, ctx?: ExecCtx | null): Promise<WebhookDelivery> {
  const endpoint = await loadEndpoint(env, userId, endpointId);
  if (endpoint.status !== 'active') throw new AppError('conflict', '端点已停用，先重新启用再重试');
  const row = await env.db.prepare(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
    WHERE id = ? AND endpoint_id = ? AND status = 'failed' AND last_error <> ? RETURNING *`)
    .bind(Date.now(), Date.now(), deliveryId, endpointId, SOURCE_GONE).first<DeliveryRow>();
  if (!row) throw new AppError('conflict', '只有投递失败的记录可以重试');
  runDetached(ctx, processWebhookDeliveries(env, { ids: [Number(row.id)] }));
  return toDelivery(row);
}

/** 同步发一条 webhook.test 事件，返回对方的响应情况；不记入投递记录，也不计入连续失败 */
export async function testWebhookEndpoint(env: Env, userId: number, id: number): Promise<WebhookTestResult> {
  const endpoint = await loadEndpoint(env, userId, id);
  const eventId = newEventId();
  const body = JSON.stringify({ id: eventId, type: WEBHOOK_TEST_EVENT_TYPE, timestamp: new Date().toISOString(),
    data: { endpointId: Number(endpoint.id), message: 'HPC Mail Webhook 测试事件' } });
  const started = Date.now();
  try {
    const response = await send(env, endpoint, eventId, body);
    return { ok: true, httpStatus: response.status, error: '', durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, httpStatus: error instanceof NotificationDeliveryError ? error.httpStatus : null,
      error: error instanceof AppError ? error.message : '请求失败', durationMs: Date.now() - started };
  }
}

// ———————————————————————— 事件入队 ————————————————————————

/** 端点是否订阅该事件、过滤是否命中：addresses 与 domains 都为空不过滤，否则命中其一即可 */
const MATCH_SQL = `status = 'active' AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)
  AND ((json_array_length(addresses) = 0 AND json_array_length(domains) = 0)
    OR EXISTS (SELECT 1 FROM json_each(addresses) WHERE value = ?)
    OR EXISTS (SELECT 1 FROM json_each(domains) WHERE value = ?))`;

const INSERT_COLUMNS = `INSERT INTO webhook_deliveries
  (endpoint_id, user_id, event_id, event_type, event_key, payload, status, attempts, next_attempt_at, created_at, updated_at)`;

/**
 * mail.received 入队语句：给归属人们订阅了它、过滤命中的端点各插一条投递。载荷在首次投递时按端点是否要正文构造，
 * 这里只记邮件 id；去重键保证补录重复入队时不会多发。供收件通知入队时合进同一个 batch。
 */
export function mailReceivedDeliveriesStatement(
  env: Env, ownerIds: readonly number[], message: { id: number; address: string }, now = Date.now(),
): D1PreparedStatement {
  const address = normalizeEmail(message.address);
  return env.db.prepare(`${INSERT_COLUMNS}
    SELECT id, user_id, ?, 'mail.received', ?, '', 'pending', 0, ?, ?, ?
    FROM webhook_endpoints WHERE user_id IN (SELECT value FROM json_each(?)) AND ${MATCH_SQL}
    ON CONFLICT(endpoint_id, event_key) DO NOTHING RETURNING id`)
    .bind(newEventId(), `mail.received:${message.id}`, now, now, now, JSON.stringify([...new Set(ownerIds)]),
      'mail.received', address, getEmailDomain(address));
}

/**
 * 把事件写入该用户订阅了此类型、且过滤命中的启用端点的投递队列，并尽快投递。
 * 有 ctx 时写入与投递都放进 waitUntil，不增加请求延迟；ctx 为 null（定时任务、单测直调）时只等写入完成，
 * 投递由定时任务的 webhook 步骤接着处理。任何失败只记日志，不抛给调用方。
 */
export async function emitUserEvent(env: Env, userId: number, event: UserEvent, ctx?: ExecCtx | null): Promise<void> {
  const task = enqueueUserEvent(env, userId, event);
  if (ctx) {
    ctx.waitUntil(task.then((ids) => (ids.length ? processWebhookDeliveries(env, { ids }) : undefined))
      .catch((error) => console.error('Webhook 事件入队失败:', error instanceof Error ? error.message : error)));
    return;
  }
  await task.catch((error) => console.error('Webhook 事件入队失败:', error instanceof Error ? error.message : error));
}

/** 写入投递队列，返回新插入的投递 id（已有同一去重键的端点跳过） */
async function enqueueUserEvent(env: Env, userId: number, event: UserEvent): Promise<number[]> {
  const eventId = newEventId();
  const now = Date.now();
  const body = JSON.stringify({ id: eventId, type: event.type, timestamp: new Date(now).toISOString(), data: event.data });
  const address = event.address ? normalizeEmail(event.address) : null;
  const domain = (event.domain ?? (address ? getEmailDomain(address) : '')).toLowerCase() || null;
  const { results } = await env.db.prepare(`${INSERT_COLUMNS}
    SELECT id, user_id, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
    FROM webhook_endpoints WHERE user_id = ? AND ${MATCH_SQL}
    ON CONFLICT(endpoint_id, event_key) DO NOTHING RETURNING id`)
    .bind(eventId, event.type, event.key, body, now, now, now, userId, event.type, address, domain).all<{ id: number }>();
  return results.map((row) => Number(row.id));
}

/** 发信结果事件：读发件行，sent/delivered 发 mail.sent，failed 发 mail.failed；pending/unknown 不发 */
export function emitSendResult(env: Env, userId: number, messageId: number, ctx?: ExecCtx | null): Promise<void> {
  const task = (async () => {
    const row = await env.db.prepare(`SELECT id, address, domain, from_name, subject, status, error_detail, recipient_outcomes,
        recipients, created_at FROM messages WHERE id = ? AND direction = 'outbound'`).bind(messageId).first<{
        id: number; address: string; domain: string; from_name: string; subject: string; status: string; error_detail: string | null;
        recipient_outcomes: string; recipients: string; created_at: number;
      }>();
    if (!row) return [];
    const type = row.status === 'failed' ? 'mail.failed' : row.status === 'sent' || row.status === 'delivered' ? 'mail.sent' : null;
    if (!type) return [];
    const recipients = JSON.parse(row.recipients) as MessageRecipients;
    return enqueueUserEvent(env, userId, {
      type, key: `${type}:${row.id}`, address: row.address, domain: row.domain,
      data: { message: {
        id: Number(row.id), direction: 'outbound', address: row.address, domain: row.domain, fromName: row.from_name,
        subject: row.subject, status: row.status, errorDetail: row.error_detail ?? '',
        recipientOutcomes: JSON.parse(row.recipient_outcomes) as RecipientOutcome[],
        recipients: { to: recipients.to ?? [], cc: recipients.cc ?? [], bcc: recipients.bcc ?? [] },
        createdAt: new Date(Number(row.created_at)).toISOString(),
      } },
    });
  })();
  const run = task.then((ids) => (ids.length ? processWebhookDeliveries(env, { ids }) : undefined))
    .then(() => undefined)
    .catch((error) => console.error('发信结果事件失败:', error instanceof Error ? error.message : error));
  if (ctx) {
    ctx.waitUntil(run);
    return Promise.resolve();
  }
  return run;
}

/** 托管域名状态变化：可以收信、发信就绪、NS 迁走。去重键带上一次核对时间，并发核对同一变化只发一次 */
export async function emitHostedDomainTransitions(
  env: Env,
  before: { id: number; userId: number; domain: string; status: string; routingStatus: string; catchAllReady: boolean;
    sendingStatus: string; checkedAt: Date | null },
  after: { status: string; zoneStatus?: string; routingStatus?: string; catchAllReady?: boolean; sendingStatus?: string },
): Promise<void> {
  const routing = after.routingStatus ?? before.routingStatus;
  const catchAll = after.catchAllReady ?? before.catchAllReady;
  const sending = after.sendingStatus ?? before.sendingStatus;
  const types: WebhookEventType[] = [];
  if (routing === 'ready' && catchAll && !(before.routingStatus === 'ready' && before.catchAllReady)) types.push('hosted_domain.activated');
  if (sending === 'ready' && before.sendingStatus !== 'ready') types.push('hosted_domain.sending_ready');
  if (after.status === 'moved' && before.status !== 'moved') types.push('hosted_domain.moved');
  const since = before.checkedAt?.getTime() ?? 0;
  // 由定时任务的 webhook 步骤投递（同一轮里排在托管域名核对之后）
  for (const type of types) {
    await enqueueUserEvent(env, before.userId, {
      type, key: `${type}:${before.id}:${since}`, domain: before.domain,
      data: { hostedDomain: { id: before.id, domain: before.domain, status: after.status, zoneStatus: after.zoneStatus ?? null,
        receivingReady: routing === 'ready' && catchAll, sendingReady: sending === 'ready' } },
    }).catch((error) => console.error('托管域名事件入队失败:', error instanceof Error ? error.message : error));
  }
}

// ———————————————————————— 投递 ————————————————————————

function runDetached(ctx: ExecCtx | null | undefined, task: Promise<unknown>): void {
  const guarded = task.catch((error) => console.error('Webhook 投递失败:', error instanceof Error ? error.message : error));
  if (ctx) ctx.waitUntil(guarded);
}

async function send(env: Env, endpoint: EndpointRow, eventId: string, body: string) {
  const url = await validateWebhookEndpointUrl(env, endpoint.url);
  return notificationRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...(await svixHeaders(endpoint.secret, eventId, body)) },
    body,
  }, 'Webhook');
}

const clip = (text: string) => (text.length > WEBHOOK_BODY_MAX_CHARS ? text.slice(0, WEBHOOK_BODY_MAX_CHARS) : text);

/** mail.received 的 data：邮件摘要、收件人、附件摘要；端点要求时带正文（各自截断） */
async function mailReceivedData(env: Env, messageId: number, includeBody: boolean): Promise<Record<string, unknown> | null> {
  const [messageResult, attachmentResult] = await env.db.batch([
    env.db.prepare(`SELECT id, address, domain, from_address, from_name, subject, preview, verification_code, verification_link,
        recipients, reply_to, created_at, body_text, body_html, body_r2_key FROM messages WHERE id = ? AND deleted_at IS NULL`).bind(messageId),
    env.db.prepare(`SELECT id, filename, mime_type, size, content_id, disposition FROM attachments WHERE message_id = ? ORDER BY id`).bind(messageId),
  ]);
  const row = messageResult?.results?.[0] as {
    id: number; address: string; domain: string; from_address: string; from_name: string; subject: string; preview: string;
    verification_code: string; verification_link: string | null; recipients: string; reply_to: string; created_at: number;
    body_text: string; body_html: string; body_r2_key: string | null;
  } | undefined;
  if (!row) return null;
  const recipients = JSON.parse(row.recipients) as MessageRecipients;
  const message: Record<string, unknown> = {
    id: Number(row.id), direction: 'inbound', address: row.address, domain: row.domain,
    fromAddress: row.from_address, fromName: row.from_name, subject: row.subject, preview: row.preview,
    verificationCode: resolveVerificationCode(row.subject, row.preview, row.verification_code, { bodyTruncated: row.preview.length >= PREVIEW_LIMIT }),
    verificationLink: row.verification_link ?? '',
    recipients: { to: recipients.to ?? [], cc: recipients.cc ?? [] },
    replyTo: JSON.parse(row.reply_to) as string[],
    attachments: ((attachmentResult?.results ?? []) as { id: number; filename: string; mime_type: string; size: number; content_id: string; disposition: string }[])
      .map((att) => ({ id: Number(att.id), filename: att.filename, mimeType: att.mime_type, size: Number(att.size),
        inline: att.disposition === 'inline' && att.content_id !== '' })),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
  if (includeBody) {
    let text = row.body_text;
    let html = row.body_html;
    if (row.body_r2_key) {
      const full = await getJson<{ text?: string; html?: string }>(env, row.body_r2_key);
      if (typeof full?.text === 'string') text = full.text;
      if (typeof full?.html === 'string') html = full.html;
    }
    message.text = clip(text);
    message.html = clip(html);
    message.bodyTruncated = text.length > WEBHOOK_BODY_MAX_CHARS || html.length > WEBHOOK_BODY_MAX_CHARS;
  }
  return { message };
}

export interface WebhookProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  deferred: number;
}

/**
 * 投递到期的事件：逐条原子认领（pending → processing、attempts+1），发送后写回结果。
 * 失败按 RETRY_DELAYS_MS 退避，共 WEBHOOK_MAX_ATTEMPTS 次；用尽仍失败、且端点自这条投递创建以来没有成功过，
 * 视为连续失败，自动停用端点并通知所有者。成功后清空载荷（可能含验证码与正文）。
 */
export async function processWebhookDeliveries(env: Env, options: { ids?: number[]; limit?: number } = {}): Promise<WebhookProcessResult> {
  const result: WebhookProcessResult = { processed: 0, succeeded: 0, failed: 0, deferred: 0 };
  const now = Date.now();
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const ids = options.ids?.slice(0, 90);
  if (ids && !ids.length) return result;
  const [, due] = await env.db.batch([
    env.db.prepare(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'processing' AND updated_at < ?`).bind(now, now, now - PROCESSING_LEASE_MS),
    env.db.prepare(`SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?
      ${ids ? 'AND id IN (SELECT value FROM json_each(?))' : ''} ORDER BY next_attempt_at, id LIMIT ?`)
      .bind(now, ...(ids ? [JSON.stringify(ids)] : []), limit),
  ]);
  const candidates = ((due?.results ?? []) as { id: number }[]).map((row) => Number(row.id));
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (index < candidates.length) {
      const id = candidates[index++]!;
      try {
        const outcome = await deliverOne(env, id);
        if (!outcome) continue;
        result.processed += 1;
        result[outcome] += 1;
      } catch (error) {
        console.error('Webhook 投递处理失败:', error instanceof Error ? error.message : error);
      }
    }
  }));
  return result;
}

async function deliverOne(env: Env, id: number): Promise<'succeeded' | 'failed' | 'deferred' | null> {
  const startedAt = Date.now();
  const claimed = await env.db.prepare(`UPDATE webhook_deliveries SET status = 'processing', attempts = attempts + 1,
      last_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? RETURNING *`)
    .bind(startedAt, startedAt, id, startedAt).first<DeliveryRow>();
  if (!claimed) return null;
  const endpoint = await env.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').bind(claimed.endpoint_id).first<EndpointRow>();
  const finish = (status: WebhookDeliveryStatus, fields: { error?: string; httpStatus?: number | null; next?: number; payload?: string }) =>
    env.db.prepare(`UPDATE webhook_deliveries SET status = ?, last_error = ?, last_http_status = ?, next_attempt_at = ?, payload = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND attempts = ?`)
      .bind(status, (fields.error ?? '').slice(0, 300), fields.httpStatus ?? null, fields.next ?? Date.now(), fields.payload ?? claimed.payload,
        Date.now(), id, claimed.attempts);
  // 端点停用时保留载荷：重新启用后可以手动重试
  if (!endpoint || endpoint.status !== 'active') {
    await finish('failed', { error: ENDPOINT_GONE }).run();
    return 'failed';
  }
  let payload = claimed.payload;
  if (!payload) {
    const data = claimed.event_type === 'mail.received'
      ? await mailReceivedData(env, Number(claimed.event_key.split(':')[1]), Boolean(endpoint.include_body))
      : null;
    if (!data) {
      await finish('failed', { error: SOURCE_GONE, payload: '' }).run();
      return 'failed';
    }
    payload = JSON.stringify({ id: claimed.event_id, type: claimed.event_type, timestamp: new Date(Number(claimed.created_at)).toISOString(), data });
  }

  try {
    const response = await send(env, endpoint, claimed.event_id, payload);
    const done = Date.now();
    await env.db.batch([
      finish('succeeded', { httpStatus: response.status, payload: '' }),
      env.db.prepare(`UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = ? WHERE id = ?`).bind(done, endpoint.id),
    ]);
    return 'succeeded';
  } catch (error) {
    const message = error instanceof AppError ? error.message : '请求失败';
    const httpStatus = error instanceof NotificationDeliveryError ? error.httpStatus : null;
    const done = Date.now();
    const final = claimed.attempts >= WEBHOOK_MAX_ATTEMPTS;
    // 自动重试用尽（第 WEBHOOK_MAX_ATTEMPTS 次）也失败、且这条投递创建以来端点一次都没成功过：连续失败，自动停用。
    // 手动重试（attempts 超过上限）失败不再停用，用户刚重新启用的端点不会被一次重试又关掉
    const exhausted = claimed.attempts === WEBHOOK_MAX_ATTEMPTS;
    const next = done + (RETRY_DELAYS_MS[claimed.attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!);
    const reason = `连续投递失败，已自动停用（最近一次：${message}）`.slice(0, 300);
    const [, disabled] = await env.db.batch([
      finish(final ? 'failed' : 'pending', { error: message, httpStatus, next, payload }),
      env.db.prepare(`UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = ?,
          status = CASE WHEN ? AND status = 'active' AND (last_success_at IS NULL OR last_success_at < ?) THEN 'disabled' ELSE status END,
          disabled_reason = CASE WHEN ? AND status = 'active' AND (last_success_at IS NULL OR last_success_at < ?) THEN ? ELSE disabled_reason END
        WHERE id = ? RETURNING status, disabled_reason`)
        .bind(done, exhausted ? 1 : 0, claimed.created_at, exhausted ? 1 : 0, claimed.created_at, reason, endpoint.id),
    ]);
    const after = disabled?.results?.[0] as { status: string; disabled_reason: string } | undefined;
    if (exhausted && endpoint.status === 'active' && after?.status === 'disabled' && after.disabled_reason === reason) {
      await notifyEndpointDisabled(env, endpoint, message);
    }
    return final ? 'failed' : 'deferred';
  }
}

/** 端点被自动停用：通过所有者已配置的飞书 / PushDeer 告知（尽力而为）；网页与 API 上可见 disabledReason */
async function notifyEndpointDisabled(env: Env, endpoint: EndpointRow, lastError: string): Promise<void> {
  try {
    const [prefs, user] = await Promise.all([
      getUserNotifyPrefs(env, Number(endpoint.user_id)),
      env.db.prepare('SELECT username FROM users WHERE id = ?').bind(endpoint.user_id).first<{ username: string }>(),
    ]);
    const [domain] = await getDomains(env);
    const info = {
      subject: 'Webhook 端点已自动停用', fromAddress: `system@${domain ?? 'localhost'}`, fromName: 'HPC Mail',
      toAddress: user?.username ?? '', code: '',
      body: `端点 ${new URL(endpoint.url).host} 连续投递失败，已自动停用。最近错误：${lastError}\n修复接收端后，在个人设置的 Webhook 里重新启用并重试失败的投递。`,
    };
    await Promise.allSettled([sendFeishuNotification(prefs.feishu, info), sendPushDeerNotification(prefs.pushdeer, info)]);
  } catch (error) {
    console.error('Webhook 停用通知失败:', error instanceof Error ? error.message : error);
  }
}

/** 定时清理：终态投递保留 30 天 */
export async function cleanupWebhookDeliveries(env: Env, retentionDays = 30): Promise<number> {
  const result = await env.db.prepare(`DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries
    WHERE status IN ('succeeded', 'failed') AND created_at < ? LIMIT 1000)`).bind(Date.now() - retentionDays * 86_400_000).run();
  return result.meta.changes ?? 0;
}
