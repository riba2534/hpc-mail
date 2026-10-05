import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { normalizeEmail, getEmailDomain } from '../lib/email-address.js';
import type { NotificationHealth } from '@hpc-mail/shared';
export type { NotificationHealth, NotificationDeliveryView } from '@hpc-mail/shared';
import { createDb } from '../db/client.js';
import { mailboxes, messages, notificationJobs, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { htmlToText } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { getDomains } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { resolveNotifyOwnerIds } from './mailbox.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { NotificationDeliveryError } from './notification-http.js';
import { sendPushDeerNotification } from './pushdeer.js';
import { dayWindow, readCounter } from './rate-counter.js';
import { sendNotifyWebhook, type WebhookMailPayload } from './webhook-notify.js';
import { getJson } from './storage.js';

type Channel = typeof notificationJobs.$inferSelect.channel;
type DeliveryStatus = typeof notificationJobs.$inferSelect.status;
type Job = typeof notificationJobs.$inferSelect;
export interface MailNotificationInput {
  ownerIds?: number[];
  message: WebhookMailPayload['message'];
  text?: string;
  html?: string;
}
interface Payload {
  message: WebhookMailPayload['message'];
  body: string;
  bodyTruncated?: boolean;
}
const MAIL_CHANNELS = ['feishu', 'pushdeer', 'webhook'] as const;
const PROCESSING_LEASE_MS = 2 * 60_000;
export const FORWARD_DOMAIN_DAILY_LIMIT = 500;
export const FORWARD_TARGET_DAILY_LIMIT = 200;

/** 邮件已收妥之后才调用。队列写入/推送失败不能把一次成功收件变成 SMTP 重投。 */
export async function enqueueMailNotifications(
  env: Env,
  ctx: ExecCtx | null,
  input: MailNotificationInput,
): Promise<number[]> {
  const ids: number[] = [];
  try {
    const ownerIds = [...new Set(input.ownerIds ?? await resolveNotifyOwnerIds(env, input.message.address))];
    // 单个用户偏好读取失败不应压制其他管理员的正常通知。
    const prefs = await Promise.allSettled(ownerIds.map(id => getUserNotifyPrefs(env, id)));
    const now = new Date();
    const fullBody = input.text || htmlToText(input.html || '');
    const payload = {
      message: input.message,
      body: fullBody.slice(0, 4000),
      bodyTruncated: fullBody.length > 4000,
    } satisfies Payload;
    const rows: typeof notificationJobs.$inferInsert[] = [];
    for (let i = 0; i < ownerIds.length; i++) {
      const result = prefs[i]!;
      if (result.status !== 'fulfilled') {
        console.error('通知偏好读取失败，跳过该用户:', ownerIds[i]);
        continue;
      }
      for (const channel of MAIL_CHANNELS) {
        if (!result.value[channel].enabled) continue;
        rows.push({
          userId: ownerIds[i]!, messageId: input.message.id, channel,
          payload: payload as unknown as Record<string, unknown>,
          maxAttempts: channel === 'webhook' ? 1 : 3,
          nextAttemptAt: now, createdAt: now, updatedAt: now,
          dedupeKey: `mail:${input.message.id}:${ownerIds[i]}:${channel}`,
        });
      }
    }
    // 每条有多个 bind，必须小批次以遵守 D1 的参数上限。
    const db = createDb(env);
    for (let start = 0; start < rows.length; start += 5) {
      const inserted = await db.insert(notificationJobs).values(rows.slice(start, start + 5))
        .onConflictDoNothing({ target: notificationJobs.dedupeKey }).returning({ id: notificationJobs.id });
      ids.push(...inserted.map(row => row.id));
    }
    // 只有全部偏好读取和任务写入成功才标记；部分任务可由 cron 按快照补齐，已有 dedupe 不重复发。
    if (prefs.every(result => result.status === 'fulfilled')) {
      await db.update(messages).set({ notificationsQueuedAt: now })
        .where(and(eq(messages.id, input.message.id), isNotNull(messages.notifyOwnerIds)));
    }
  } catch {
    console.error('邮件通知任务保存失败（邮件已入库）');
  }
  if (ctx && ids.length) {
    ctx.waitUntil(processNotificationJobs(env, { jobIds: ids }).catch(() => console.error('通知队列处理失败')));
  }
  return ids;
}

/** 只恢复新收件快照；历史无快照邮件不重新归属，也不会在用户认领后补推给新主人。 */
export async function repairUnqueuedNotifications(env: Env, options: { limit?: number } = {}): Promise<number> {
  const rows = await createDb(env).select({
    id: messages.id, address: messages.address, fromAddress: messages.fromAddress, fromName: messages.fromName,
    subject: messages.subject, verificationCode: messages.verificationCode, preview: messages.preview,
    createdAt: messages.createdAt, bodyText: messages.bodyText, bodyHtml: messages.bodyHtml, bodyR2Key: messages.bodyR2Key,
    notifyOwnerIds: messages.notifyOwnerIds,
  }).from(messages).where(and(
    eq(messages.direction, 'inbound'), inArray(messages.status, ['received', 'degraded']),
    isNotNull(messages.notifyOwnerIds), isNull(messages.notificationsQueuedAt), isNull(messages.deletedAt),
  )).orderBy(asc(messages.createdAt), asc(messages.id)).limit(Math.max(1, Math.min(100, options.limit ?? 30)));
  let queued = 0;
  for (const row of rows) {
    if (!Array.isArray(row.notifyOwnerIds) || row.notifyOwnerIds.some(id => !Number.isInteger(id) || id <= 0)) continue;
    try {
      let text = row.bodyText;
      let html = row.bodyHtml;
      if (row.bodyR2Key) {
        const body = await getJson<{ text?: string; html?: string }>(env, row.bodyR2Key);
        if (typeof body?.text === 'string') text = body.text;
        if (typeof body?.html === 'string') html = body.html;
      }
      queued += (await enqueueMailNotifications(env, null, { ownerIds: row.notifyOwnerIds,
        message: { id: row.id, address: row.address, fromAddress: row.fromAddress, fromName: row.fromName,
          subject: row.subject, verificationCode: row.verificationCode, preview: row.preview, createdAt: row.createdAt.toISOString() },
        text, html,
      })).length;
    } catch {
      console.error('收件通知任务补录失败:', row.id);
    }
  }
  return queued;
}

async function deliver(env: Env, job: Job): Promise<boolean> {
  const user = await createDb(env).select({ status: users.status }).from(users).where(eq(users.id, job.userId)).get();
  if (!user || user.status !== 'active') return false;
  const prefs = await getUserNotifyPrefs(env, job.userId);
  if (job.channel === 'forward' || !prefs[job.channel].enabled) return false;
  const payload = job.payload as unknown as Payload;
  if (!payload.message || typeof payload.body !== 'string') {
    throw new NotificationDeliveryError('通知任务格式无效', null, false);
  }
  const message = payload.message;
  const info = {
    subject: message.subject, fromAddress: message.fromAddress, fromName: message.fromName,
    toAddress: message.address, code: message.verificationCode,
    body: payload.body + (payload.bodyTruncated ? '\n…（正文过长，已截断）' : ''),
  };
  if (job.channel === 'feishu') {
    await sendFeishuNotification(prefs.feishu, info, { throwOnError: true, attempts: 1 });
  } else if (job.channel === 'pushdeer') {
    await sendPushDeerNotification(prefs.pushdeer, info, { throwOnError: true });
  } else {
    await sendNotifyWebhook(prefs.webhook, { event: 'mail.received', message }, { throwOnError: true });
  }
  return true;
}

export interface NotificationProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  deferred: number;
  skipped: number;
}

/** 原子认领避免并发重复投递；不确定的旧 processing 不自动重发，避免误报/重复通知。 */
export async function processNotificationJobs(
  env: Env,
  options: { limit?: number; concurrency?: number; jobIds?: number[] } = {},
): Promise<NotificationProcessResult> {
  const db = createDb(env);
  const now = new Date();
  await db.update(notificationJobs).set({
    status: 'unknown', lastError: '任务处理超时，投递结果未确认，请检查后手动重试', updatedAt: now,
  }).where(and(eq(notificationJobs.status, 'processing'), lt(notificationJobs.updatedAt, new Date(now.getTime() - PROCESSING_LEASE_MS))));
  const result: NotificationProcessResult = { processed: 0, succeeded: 0, failed: 0, deferred: 0, skipped: 0 };
  if (options.jobIds && !options.jobIds.length) return result;
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 8)));
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 4)));
  const candidates = await db.select({ id: notificationJobs.id }).from(notificationJobs).where(and(
    eq(notificationJobs.status, 'pending'), lte(notificationJobs.nextAttemptAt, now),
    inArray(notificationJobs.channel, [...MAIL_CHANNELS]),
    options.jobIds ? inArray(notificationJobs.id, options.jobIds.slice(0, 90)) : undefined,
  )).orderBy(asc(notificationJobs.nextAttemptAt), asc(notificationJobs.id)).limit(limit);
  let index = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (index < candidates.length) {
      const candidate = candidates[index++]!;
      const claimed = await db.update(notificationJobs).set({
        status: 'processing', attempts: sql`${notificationJobs.attempts} + 1`,
        lastAttemptAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(notificationJobs.id, candidate.id), eq(notificationJobs.status, 'pending'),
        lte(notificationJobs.nextAttemptAt, now))).returning().get();
      if (!claimed) continue;
      result.processed += 1;
      let status: DeliveryStatus = 'succeeded';
      let lastError = '';
      let lastHttpStatus: number | null = null;
      let nextAttemptAt = new Date();
      try {
        if (!await deliver(env, claimed)) {
          status = 'skipped';
          lastError = '用户或该通知通道已停用';
          result.skipped += 1;
        } else {
          result.succeeded += 1;
        }
      } catch (error) {
        const retryable = error instanceof NotificationDeliveryError ? error.retryable : !(error instanceof AppError);
        lastHttpStatus = error instanceof NotificationDeliveryError ? error.httpStatus : null;
        lastError = error instanceof AppError ? error.message.slice(0, 300) : '通知任务处理失败';
        if (retryable && claimed.attempts < claimed.maxAttempts && claimed.channel !== 'webhook') {
          status = 'pending';
          nextAttemptAt = new Date(Date.now() + 60_000 * 2 ** (claimed.attempts - 1));
          result.deferred += 1;
        } else {
          status = 'failed';
          result.failed += 1;
        }
      }
      // 若成功外发后状态写入失败，保留 processing，下一轮标记 unknown；不把它当未发自动重试。
      await db.update(notificationJobs).set({ status, lastError, lastHttpStatus, nextAttemptAt, updatedAt: new Date() })
        .where(and(eq(notificationJobs.id, claimed.id), eq(notificationJobs.status, 'processing'), eq(notificationJobs.attempts, claimed.attempts)));
    }
  }));
  if (workers.some(worker => worker.status === 'rejected')) console.error('部分通知任务数据库操作失败，保留待确认状态');
  return result;
}

/** 同步测试/转发也记录结果；调用方不得传完整端点/密钥或未经脱敏的第三方响应。 */
export async function recordDeliveryResult(env: Env, input: {
  userId: number; messageId: number | null; channel: Channel; target?: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'unknown'; error?: string; httpStatus?: number | null;
}): Promise<void> {
  const now = new Date();
  const target = input.target || '';
  const dedupeKey = input.messageId === null ? `test:${crypto.randomUUID()}` : `mail:${input.messageId}:${input.userId}:${input.channel}:${target}`;
  try {
    await createDb(env).insert(notificationJobs).values({
      userId: input.userId, messageId: input.messageId, channel: input.channel, target,
      payload: {}, status: input.status, attempts: 1, maxAttempts: 1, nextAttemptAt: now,
      createdAt: now, updatedAt: now, lastAttemptAt: now, lastError: (input.error || '').slice(0, 300),
      lastHttpStatus: input.httpStatus ?? null, dedupeKey,
    }).onConflictDoUpdate({ target: notificationJobs.dedupeKey, set: {
      status: input.status, lastError: (input.error || '').slice(0, 300), lastHttpStatus: input.httpStatus ?? null, updatedAt: now,
    } });
  } catch {
    console.error('通知/转发结果保存失败');
  }
}

export async function retryNotificationJob(env: Env, userId: number, id: number): Promise<void> {
  const db = createDb(env);
  const row = await db.select().from(notificationJobs).where(and(eq(notificationJobs.id, id), eq(notificationJobs.userId, userId))).get();
  if (!row) throw new AppError('not_found', '通知任务不存在');
  if (row.channel === 'forward') throw new AppError('validation_failed', '邮箱转发请在确认收件情况后重新转发原邮件');
  if (row.messageId === null) throw new AppError('validation_failed', '请使用发送测试按钮重新验证配置');
  if (!['failed', 'unknown'].includes(row.status)) throw new AppError('conflict', '该通知任务无需重试');
  const prefs = await getUserNotifyPrefs(env, userId);
  if (!prefs[row.channel].enabled) throw new AppError('validation_failed', '请先启用该通知通道');
  // Attempts also fence the processor that owns this lease. Keep them monotonic:
  // resetting to zero lets an expired first attempt overwrite a new first attempt.
  const reset = await db.update(notificationJobs).set({
    status: 'pending', maxAttempts: row.attempts + (row.channel === 'webhook' ? 1 : 3),
    nextAttemptAt: new Date(), updatedAt: new Date(), lastError: '', lastHttpStatus: null,
  }).where(and(eq(notificationJobs.id, id), eq(notificationJobs.userId, userId),
    eq(notificationJobs.attempts, row.attempts), inArray(notificationJobs.status, ['failed', 'unknown']))).returning({ id: notificationJobs.id });
  if (!reset.length) throw new AppError('conflict', '通知任务状态已改变');
}

export async function cleanupNotificationJobs(env: Env, retentionDays = 30): Promise<void> {
  const db = createDb(env);
  const before = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000);
  const stale = await db.select({ id: notificationJobs.id }).from(notificationJobs)
    .where(and(lt(notificationJobs.createdAt, before), inArray(notificationJobs.status, ['succeeded', 'failed', 'skipped', 'unknown'])))
    .orderBy(asc(notificationJobs.createdAt)).limit(500);
  for (let start = 0; start < stale.length; start += 90) {
    await db.delete(notificationJobs).where(inArray(notificationJobs.id, stale.slice(start, start + 90).map(row => row.id)));
  }
}

export async function getNotificationHealth(env: Env, userId: number): Promise<NotificationHealth> {
  const db = createDb(env);
  const prefs = await getUserNotifyPrefs(env, userId);
  const counts = await db.select({ channel: notificationJobs.channel,
    pendingCount: sql<number>`sum(case when ${notificationJobs.status} in ('pending','processing') then 1 else 0 end)`,
    failedCount: sql<number>`sum(case when ${notificationJobs.status} in ('failed','unknown') then 1 else 0 end)`,
  }).from(notificationJobs).where(eq(notificationJobs.userId, userId)).groupBy(notificationJobs.channel);
  const channels = await Promise.all([...MAIL_CHANNELS, 'forward' as const].map(async channel => {
    const latest = await db.select({
      id: notificationJobs.id, messageId: notificationJobs.messageId, target: notificationJobs.target,
      status: notificationJobs.status, attempts: notificationJobs.attempts, maxAttempts: notificationJobs.maxAttempts,
      lastError: notificationJobs.lastError, lastHttpStatus: notificationJobs.lastHttpStatus,
      createdAt: notificationJobs.createdAt, updatedAt: notificationJobs.updatedAt,
      nextAttemptAt: notificationJobs.nextAttemptAt, lastAttemptAt: notificationJobs.lastAttemptAt,
    }).from(notificationJobs).where(and(eq(notificationJobs.userId, userId), eq(notificationJobs.channel, channel)))
      .orderBy(desc(notificationJobs.id)).get();
    const count = counts.find(row => row.channel === channel);
    return {
      channel, enabled: prefs[channel].enabled,
      latest: latest ? { ...latest, createdAt: latest.createdAt.toISOString(), updatedAt: latest.updatedAt.toISOString(),
        nextAttemptAt: latest.nextAttemptAt.toISOString(), lastAttemptAt: latest.lastAttemptAt?.toISOString() ?? null } : null,
      pendingCount: Number(count?.pendingCount || 0), failedCount: Number(count?.failedCount || 0),
    };
  }));
  const now = new Date();
  const window = dayWindow(now);
  const user = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get();
  const owned = await db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, userId));
  const domains = [...new Set([
    ...owned.map(row => getEmailDomain(row.address)),
    ...(user?.role === 'admin' ? await getDomains(env) : []),
  ])];
  return { channels, forward: {
    domainLimit: FORWARD_DOMAIN_DAILY_LIMIT, targetLimit: FORWARD_TARGET_DAILY_LIMIT,
    windowEndsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    targets: await Promise.all([...new Set(prefs.forward.addresses.map(normalizeEmail))].map(async address => {
      const { count } = await readCounter(env, 'fwd-target', address, window);
      return { address, attempts: count, remaining: Math.max(0, FORWARD_TARGET_DAILY_LIMIT - count) };
    })),
    domains: await Promise.all(domains.map(async domain => {
      const { count } = await readCounter(env, 'fwd-domain', domain, window);
      return { domain, attempts: count, remaining: Math.max(0, FORWARD_DOMAIN_DAILY_LIMIT - count) };
    })),
  } };
}
