import { DRAFT_ATTACHMENT_TTL_HOURS } from '@hpc-mail/shared';
import { and, eq, inArray, isNotNull, lt, notInArray, type SQL } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import {
  apiRateLimits,
  draftAttachments,
  idempotencyRecords,
  mailboxes,
  messages,
  sessions,
} from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import type { Env } from '../types.js';
import { dayWindow, minuteWindow, purgeCounters } from './rate-counter.js';
import { getSettings } from './setting.js';
import { purgeMatchingMessages, purgeStatements } from './message-lifecycle.js';
import { processStorageCleanup, expireExternalAttachmentLinks, expireDeliveryObjectLeases } from './storage-cleanup.js';
import { processNotificationJobs, cleanupNotificationJobs, repairUnqueuedNotifications } from './notification-jobs.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 回收站保留天数：软删除超过此天数由 scheduled 硬删 */
const TRASH_RETENTION_DAYS = 7;
/** 单次清理批量上限，防止单次 cron 运行过久（下一次继续清剩余） */
const RETENTION_BATCH = 1000;
const RETENTION_MAX_BATCHES = 10;

/** 按 where 条件删除邮件（D1 行 + R2 对象：正文/附件/原始 .eml），返回删除条数；限批量 */
async function purgeMessagesWhere(env: Env, cond: SQL): Promise<number> {
  return purgeMatchingMessages(env, cond, RETENTION_BATCH);
}

/** 邮件保留清理：未认领地址 + 全局上限；各自独立 try/catch 互不影响 */
async function runRetention(env: Env): Promise<void> {
  const settings = await getSettings(env);
  const { unclaimedDays, allMessagesDays } = settings.retention;
  const db = createDb(env);

  if (unclaimedDays > 0) {
    try {
      const cutoff = new Date(Date.now() - unclaimedDays * DAY_MS);
      // 未被任何用户认领的地址收到的 inbound 邮件（catch-all 垃圾的主要来源）
      const claimed = db.select({ address: mailboxes.address }).from(mailboxes);
      let total = 0;
      for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const n = await purgeMessagesWhere(
          env,
          and(
            eq(messages.direction, 'inbound'),
            lt(messages.createdAt, cutoff),
            notInArray(messages.address, claimed),
          )!,
        );
        total += n;
        if (n < RETENTION_BATCH) break;
      }
      if (total > 0) console.log(`保留清理：删除未认领地址邮件 ${total} 封`);
    } catch (e) {
      console.error('未认领地址保留清理失败:', e);
    }
  }

  if (allMessagesDays > 0) {
    try {
      const cutoff = new Date(Date.now() - allMessagesDays * DAY_MS);
      let total = 0;
      for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const n = await purgeMessagesWhere(env, lt(messages.createdAt, cutoff));
        total += n;
        if (n < RETENTION_BATCH) break;
      }
      if (total > 0) console.log(`保留清理：删除超期邮件 ${total} 封`);
    } catch (e) {
      console.error('全局保留清理失败:', e);
    }
  }
}

/** 草稿附件孤儿清理：上传后未发送、超过 TTL 的 draft（含未完成 multipart）→ 回收 R2 + 删行 */
async function runDraftAttachmentCleanup(env: Env): Promise<void> {
  const db = createDb(env);
  const cutoff = new Date(Date.now() - DRAFT_ATTACHMENT_TTL_HOURS * 3600 * 1000);
  const stale = await db
    .select({
      id: draftAttachments.id,
      r2Key: draftAttachments.r2Key,
      uploadId: draftAttachments.uploadId,
      status: draftAttachments.status,
    })
    .from(draftAttachments)
    .where(lt(draftAttachments.createdAt, cutoff))
    .limit(RETENTION_BATCH)
    .all();
  if (stale.length === 0) return;
  const cleaned: number[] = [];
  for (const s of stale) {
    if (s.uploadId && s.status === 'uploading') {
      try {
        await env.r2.resumeMultipartUpload(s.r2Key, s.uploadId).abort();
        cleaned.push(s.id);
      } catch (e) {
        console.error('清理：abort multipart 失败:', e);
      }
    } else {
      try {
        await env.r2.delete(s.r2Key);
        cleaned.push(s.id);
      } catch (e) {
        console.error('清理：删草稿 R2 失败:', e);
      }
    }
  }
  for (const batch of chunk(cleaned)) {
    await db.delete(draftAttachments).where(inArray(draftAttachments.id, batch));
  }
  console.log(`草稿附件清理：删除 ${cleaned.length} 个过期草稿`);
}

/** 每日清理：审计日志 90 天 + 过期限流窗口 + 邮件保留策略 */
export async function runScheduled(env: Env, maintenance = true): Promise<void> {
  try { await repairUnqueuedNotifications(env); await processNotificationJobs(env); } catch (error) { console.error('通知任务处理失败:', error); }
  try {
    // Recover a metadata purge interrupted between reservation and transaction completion.
    const tokens = await env.db.prepare('SELECT DISTINCT purge_token AS token FROM messages WHERE purge_token IS NOT NULL LIMIT 20').all<{ token: string }>();
    for (const row of tokens.results) await env.db.batch(purgeStatements(env, row.token));
    await expireDeliveryObjectLeases(env);
    await expireExternalAttachmentLinks(env);
    await processStorageCleanup(env, 100);
  } catch (error) { console.error('持久化清理任务失败:', error); }
  if (!maintenance) return;
  await cleanupNotificationJobs(env);
  const db = createDb(env);
  const cutoff = new Date(Date.now() - NINETY_DAYS_MS);
  const staleWindow = Math.floor(Date.now() / 60000) - 120;

  for (const table of ['api_request_logs', 'admin_audit_logs']) {
    try {
      const deadline = Date.now() + 5000;
      for (let i = 0; i < 300 && Date.now() < deadline; i++) {
        const result = await env.db.prepare(`DELETE FROM ${table} WHERE id IN
          (SELECT id FROM ${table} WHERE created_at < ? LIMIT 1000)`).bind(cutoff.getTime()).run();
        if ((result.meta.changes ?? 0) < 1000) break;
      }
    } catch (error) { console.error(`${table} 清理失败:`, error); }
  }
  try {
    await db.delete(apiRateLimits).where(lt(apiRateLimits.windowStart, staleWindow));
  } catch (e) {
    console.error('限流窗口清理失败:', e);
  }
  try {
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await db
      .delete(idempotencyRecords)
      .where(and(lt(idempotencyRecords.createdAt, new Date(Date.now() - 2 * DAY_MS)), eq(idempotencyRecords.status, 'completed')));
  } catch (e) {
    console.error('会话/幂等记录清理失败:', e);
  }
  try {
    await runRetention(env);
  } catch (e) {
    console.error('邮件保留清理失败:', e);
  }
  // 回收站：软删除超过 7 天硬删
  try {
    const trashCutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * DAY_MS);
    const n = await purgeMessagesWhere(
      env,
      and(isNotNull(messages.deletedAt), lt(messages.deletedAt, trashCutoff))!,
    );
    if (n > 0) console.log(`回收站清理：硬删 ${n} 封`);
  } catch (e) {
    console.error('回收站清理失败:', e);
  }
  // 草稿附件：超过 TTL 未发送的孤儿（上传未完成或未点发送）→ 回收 R2 + 删行
  try {
    await runDraftAttachmentCleanup(env);
  } catch (e) {
    console.error('草稿附件清理失败:', e);
  }
  // 计数器：外发/转发配额按天、登录失败与注册限流按分钟窗口，各自回收过期行
  try {
    await purgeCounters(env, 'out', dayWindow(new Date(Date.now() - 3 * DAY_MS)));
    await purgeCounters(env, 'fwd-domain', dayWindow(new Date(Date.now() - 3 * DAY_MS)));
    await purgeCounters(env, 'fwd-target', dayWindow(new Date(Date.now() - 3 * DAY_MS)));
    await purgeCounters(env, 'api-user', minuteWindow(1) - 120);
    await purgeCounters(env, 'api-global', minuteWindow(1) - 120);
    await purgeCounters(env, 'api-wait', minuteWindow(1) - 120);
    await purgeCounters(env, 'auth-user', minuteWindow(1) - 120);
    await purgeCounters(env, 'auth-global', minuteWindow(1) - 120);
    await purgeCounters(env, 'ai-extract', dayWindow(new Date(Date.now() - 3 * DAY_MS)));
    await purgeCounters(env, 'login-fail', minuteWindow(15) - 8);
    await purgeCounters(env, 'reg', minuteWindow(60) - 3);
  } catch (e) {
    console.error('计数器清理失败:', e);
  }
}
