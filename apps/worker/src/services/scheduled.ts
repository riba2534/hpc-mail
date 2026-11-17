import { DRAFT_ATTACHMENT_TTL_HOURS } from '@hpc-mail/shared';
import { and, eq, exists, inArray, isNotNull, lt, notInArray, or, type SQL } from 'drizzle-orm';
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
import { API_REJECT_SCOPE, dayWindow, minuteWindow, OUTBOUND_QUOTA_SCOPE, purgeCounters } from './rate-counter.js';
import { getSettings } from './setting.js';
import { purgeMatchingMessages, purgeStatements } from './message-lifecycle.js';
import { harvestRecentClaudeFacts } from './claude-facts.js';
import {
  HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, syncDueHostedDomains,
} from './hosted-domain.js';
import { HOSTED_DNS_RATE_SCOPE } from './hosted-dns.js';
import { purgeHostedTombstones } from './hosted-tombstone.js';
import { CANARY_RATE_SCOPE, writeCronHeartbeat } from './ops-probe.js';
import {
  processStorageCleanup, expireExternalAttachmentLinks, expireDeliveryObjectLeases, purgeOrphanAttachments,
} from './storage-cleanup.js';
import { FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE } from './forwarding.js';
import { processNotificationJobs, cleanupNotificationJobs, repairUnqueuedNotifications } from './notification-jobs.js';
import { TRANSLATE_CHARS_SCOPE, TRANSLATE_REQUESTS_SCOPE } from './translate.js';
import { releaseDraftStatements } from './upload.js';
import { markStaleOutbound } from './outbound-recovery.js';
import { offloadMailBodies } from './body-offload.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 幂等记录保留：已完成的 2 天（按创建时间）；仍是 pending、但发件行已终态的同样保留 2 天（按最后更新时间），
 * 保留期内同 Key 重试仍被拦下，不会当成新请求重发；失败的 7 天。
 */
const IDEMPOTENCY_SETTLED_RETENTION_MS = 2 * DAY_MS;
const IDEMPOTENCY_FAILED_RETENTION_MS = 7 * DAY_MS;
/** Claude 地址事实归纳窗口：5 分钟一次扫最近 1 小时，每日再扫最近 3 天，重叠窗口兜住漏跑 */
const CLAUDE_FACTS_WINDOW_MS = 60 * 60 * 1000;
const CLAUDE_FACTS_CATCHUP_MS = 3 * DAY_MS;
/** 回收站保留天数：软删除超过此天数由 scheduled 硬删 */
const TRASH_RETENTION_DAYS = 7;
/** 单次清理批量上限，防止单次 cron 运行过久（下一次继续清剩余） */
const RETENTION_BATCH = 1000;
const RETENTION_MAX_BATCHES = 10;

/** 按 where 条件删除邮件（D1 行 + R2 对象：正文/附件/原始 .eml），返回删除条数；限批量 */
async function purgeMessagesWhere(env: Env, cond: SQL): Promise<number> {
  return purgeMatchingMessages(env, cond, RETENTION_BATCH);
}

/** 邮件保留清理：未认领地址 + 全局上限；各自独立 try/catch 互不影响；返回删除封数 */
async function runRetention(env: Env): Promise<number> {
  const settings = await getSettings(env);
  const { unclaimedDays, allMessagesDays } = settings.retention;
  const db = createDb(env);
  let deleted = 0;

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
      deleted += total;
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
      deleted += total;
      if (total > 0) console.log(`保留清理：删除超期邮件 ${total} 封`);
    } catch (e) {
      console.error('全局保留清理失败:', e);
    }
  }
  return deleted;
}

/**
 * 草稿附件孤儿清理：上传后未发送、超过 TTL 的草稿删行。未完成的分片上传直接 abort；已完成的对象
 * 可能已被发出（含全部失败而保留）的邮件附件直接引用，改为登记清理台账，由 processStorageCleanup 按引用判断。
 */
export async function runDraftAttachmentCleanup(env: Env): Promise<number> {
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
  if (stale.length === 0) return 0;
  const aborted: number[] = [];
  const released: number[] = [];
  for (const s of stale) {
    if (s.uploadId && s.status === 'uploading') {
      try {
        await env.r2.resumeMultipartUpload(s.r2Key, s.uploadId).abort();
        aborted.push(s.id);
      } catch (e) {
        console.error('清理：abort multipart 失败:', e);
      }
    } else {
      released.push(s.id);
    }
  }
  for (const batch of chunk(aborted)) {
    await db.delete(draftAttachments).where(inArray(draftAttachments.id, batch));
  }
  for (const batch of chunk(released)) {
    await env.db.batch(releaseDraftStatements(env, batch));
  }
  const cleaned = aborted.length + released.length;
  console.log(`草稿附件清理：删除 ${cleaned} 个过期草稿`);
  return cleaned;
}

interface StepReport {
  step: string;
  ms: number;
  count?: number;
  failed?: true;
}

/** 每个步骤独立 try/catch，一步失败不影响后续步骤；记录耗时与处理条数 */
async function step(report: StepReport[], name: string, task: () => Promise<number | void>): Promise<void> {
  const started = Date.now();
  try {
    const count = await task();
    report.push({ step: name, ms: Date.now() - started, ...(typeof count === 'number' ? { count } : {}) });
  } catch (error) {
    console.error(`定时任务步骤 ${name} 失败:`, error);
    report.push({ step: name, ms: Date.now() - started, failed: true });
  }
}

/**
 * 每 5 分钟（maintenance=false）：通知补录与投递、清理台账；
 * 每日（maintenance=true）：审计日志 90 天 + 过期限流窗口 + 邮件保留策略。
 * 16:00 两个 cron 同时触发，每日那次只跑维护步骤，常规步骤由同时刻的 5 分钟 cron 负责，不重复执行。
 * 每次结束检查 cron 心跳，build 变化才写（含失败步骤），供部署后确认 scheduled 已在新版本上运行。
 */
export async function runScheduled(env: Env, maintenance = true, cron = maintenance ? 'maintenance' : 'regular'): Promise<void> {
  const started = Date.now();
  const report: StepReport[] = [];
  if (maintenance) await runMaintenance(env, report);
  else await runRegular(env, report);
  console.log(JSON.stringify({ event: 'scheduled', maintenance, ms: Date.now() - started, steps: report }));
  await writeCronHeartbeat(env, cron, report.filter((item) => item.failed).map((item) => item.step));
}

async function runRegular(env: Env, report: StepReport[]): Promise<void> {
  await step(report, 'notification.repair', () => repairUnqueuedNotifications(env));
  await step(report, 'notification.process', async () => (await processNotificationJobs(env)).processed);
  // Recover a metadata purge interrupted between reservation and transaction completion.
  await step(report, 'purge.recover', async () => {
    const tokens = await env.db.prepare('SELECT DISTINCT purge_token AS token FROM messages WHERE purge_token IS NOT NULL LIMIT 20').all<{ token: string }>();
    for (const row of tokens.results) await env.db.batch(purgeStatements(env, row.token));
    return tokens.results.length;
  });
  // 投递中断（Worker 被回收、结果回填失败）超过 1 小时仍 pending 的外发标为 unknown，幂等重放才有终态
  await step(report, 'outbound.stale', () => markStaleOutbound(env));
  await step(report, 'claude_facts.harvest', () => harvestRecentClaudeFacts(env, Date.now() - CLAUDE_FACTS_WINDOW_MS));
  await step(report, 'storage.leases', () => expireDeliveryObjectLeases(env));
  await step(report, 'storage.links', () => expireExternalAttachmentLinks(env));
  // 历史正文分批搬到 R2（放在清理之前：本轮没被引用的对象登记后同一轮就能回收）
  await step(report, 'bodies.offload', () => offloadMailBodies(env));
  await step(report, 'storage.cleanup', () => processStorageCleanup(env, 100));
  await step(report, 'hosted_domains.sync', () => syncDueHostedDomains(env));
}

async function runMaintenance(env: Env, report: StepReport[]): Promise<void> {
  await step(report, 'claude_facts.catchup', () => harvestRecentClaudeFacts(env, Date.now() - CLAUDE_FACTS_CATCHUP_MS));
  await step(report, 'notification.cleanup', () => cleanupNotificationJobs(env));
  const db = createDb(env);
  const cutoff = new Date(Date.now() - NINETY_DAYS_MS);
  const staleWindow = Math.floor(Date.now() / 60000) - 120;

  for (const table of ['api_request_logs', 'admin_audit_logs']) {
    await step(report, `${table}.cleanup`, async () => {
      let deleted = 0;
      const deadline = Date.now() + 5000;
      for (let i = 0; i < 300 && Date.now() < deadline; i++) {
        const result = await env.db.prepare(`DELETE FROM ${table} WHERE id IN
          (SELECT id FROM ${table} WHERE created_at < ? LIMIT 1000)`).bind(cutoff.getTime()).run();
        deleted += result.meta.changes ?? 0;
        if ((result.meta.changes ?? 0) < 1000) break;
      }
      return deleted;
    });
  }
  await step(report, 'rate_limits.cleanup', async () =>
    (await db.delete(apiRateLimits).where(lt(apiRateLimits.windowStart, staleWindow)).run()).meta.changes ?? 0);
  await step(report, 'sessions.cleanup', async () =>
    (await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run()).meta.changes ?? 0);
  // 幂等记录：已完成的；失败的（保留 7 天便于排查）；以及仍是 pending、但绑定的发件行已终态的
  // （回填结果失败时留下，结果以发件行为准）。发件行仍是 pending 或没有绑定的不删
  await step(report, 'idempotency.cleanup', async () => {
    const settledBefore = new Date(Date.now() - IDEMPOTENCY_SETTLED_RETENTION_MS);
    const settledMessage = db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.id, idempotencyRecords.messageId), inArray(messages.status, ['sent', 'delivered', 'failed', 'unknown'])));
    return (await db.delete(idempotencyRecords).where(or(
      and(eq(idempotencyRecords.status, 'completed'), lt(idempotencyRecords.createdAt, settledBefore)),
      and(eq(idempotencyRecords.status, 'failed'),
        lt(idempotencyRecords.createdAt, new Date(Date.now() - IDEMPOTENCY_FAILED_RETENTION_MS))),
      and(eq(idempotencyRecords.status, 'pending'), lt(idempotencyRecords.updatedAt, settledBefore), exists(settledMessage)),
    )).run()).meta.changes ?? 0;
  });
  await step(report, 'retention', () => runRetention(env));
  // 回收站：软删除超过 7 天硬删
  await step(report, 'trash', async () => {
    const trashCutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * DAY_MS);
    const n = await purgeMessagesWhere(
      env,
      and(isNotNull(messages.deletedAt), lt(messages.deletedAt, trashCutoff))!,
    );
    if (n > 0) console.log(`回收站清理：硬删 ${n} 封`);
    return n;
  });
  // 草稿附件：超过 TTL 未发送的孤儿（上传未完成或未点发送）→ abort 分片或登记清理 + 删行
  await step(report, 'drafts', () => runDraftAttachmentCleanup(env));
  // 附件行指向已不存在的邮件（附件写入前邮件被永久删除等）：登记对象清理并删行
  await step(report, 'attachments.orphans', () => purgeOrphanAttachments(env));
  // 托管域名墓碑过了保留期：前所有者的优先权到期，NS 委派预检只看仍在的托管记录与墓碑
  await step(report, 'hosted_domains.tombstones', () => purgeHostedTombstones(env));
  // 计数器：外发/转发/翻译配额按天、各类限流按分钟窗口，按窗口单位分组回收过期行；新增计数 scope 要加进对应分组。
  // auth-user/auth-global/api-user/api-global 已由 Rate Limiting binding 计数，只剩升级前写入的旧行待回收
  await step(report, 'counters', async () => {
    await purgeCounters(env, [
      OUTBOUND_QUOTA_SCOPE, 'fwd-domain', 'fwd-target', FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE, 'ai-extract', TRANSLATE_CHARS_SCOPE,
    ], dayWindow(new Date(Date.now() - 3 * DAY_MS)));
    await purgeCounters(env, [
      'api-user', 'api-global', 'api-wait', API_REJECT_SCOPE, 'auth-user', 'auth-global', TRANSLATE_REQUESTS_SCOPE,
      HOSTED_DNS_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE,
      CANARY_RATE_SCOPE,
    ], minuteWindow(1) - 120);
    await purgeCounters(env, 'login-fail', minuteWindow(15) - 8);
    await purgeCounters(env, 'reg', minuteWindow(60) - 3);
  });
}
