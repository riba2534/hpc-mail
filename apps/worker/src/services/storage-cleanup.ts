import { and, eq, lt } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { externalAttachmentLinks, storageCleanupJobs } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import type { Env, ExecCtx } from '../types.js';

/** R2 批量删除单次最多 1000 个 key */
const R2_DELETE_BATCH = 1000;

/** 对象仍被引用：附件行、正文溢出、原始 .eml、90 天外链或尚未发送的草稿（发信直接引用草稿对象）。每个子查询各走自己的 r2_key 索引。 */
const referencedSql = (key: string) => `(EXISTS (SELECT 1 FROM attachments WHERE attachments.r2_key = ${key})
  OR EXISTS (SELECT 1 FROM messages WHERE messages.body_r2_key = ${key})
  OR EXISTS (SELECT 1 FROM messages WHERE messages.raw_r2_key = ${key})
  OR EXISTS (SELECT 1 FROM external_attachment_links WHERE external_attachment_links.r2_key = ${key})
  OR EXISTS (SELECT 1 FROM draft_attachments WHERE draft_attachments.r2_key = ${key}))`;

/** 一条查询取出台账及每个对象的租约/引用状态，替代逐对象的多次往返（导出供 EXPLAIN 回归） */
export const CLEANUP_JOBS_SQL = `SELECT storage_cleanup_jobs.r2_key AS r2_key,
    EXISTS (SELECT 1 FROM delivery_object_leases WHERE delivery_object_leases.r2_key = storage_cleanup_jobs.r2_key
      AND delivery_object_leases.expires_at > ?) AS leased,
    ${referencedSql('storage_cleanup_jobs.r2_key')} AS referenced
  FROM storage_cleanup_jobs LIMIT ?`;

interface CleanupJobRow { r2_key: string; leased: number; referenced: number }

/** Retained delivery links and other live messages always keep their shared objects. */
export async function processStorageCleanup(env: Env, limit = 100): Promise<number> {
  let jobs: CleanupJobRow[];
  try { jobs = (await env.db.prepare(CLEANUP_JOBS_SQL).bind(Date.now(), limit).all<CleanupJobRow>()).results; }
  catch (error) { console.error('R2 cleanup query deferred:', error); return 0; }
  // 投递中的租约未释放前保留台账，等租约结束后再判断。
  const open = jobs.filter((job) => !job.leased);
  const orphaned = open.filter((job) => !job.referenced).map((job) => job.r2_key);
  const retained = open.filter((job) => job.referenced).map((job) => job.r2_key);

  const deleted: string[] = [];
  const failed: string[] = [];
  for (const keys of chunk(orphaned, R2_DELETE_BATCH)) {
    try {
      await env.r2.delete(keys);
      deleted.push(...keys);
    } catch (error) {
      console.error('R2 cleanup deferred:', error);
      failed.push(...keys);
    }
  }
  const inList = (keys: string[]) => keys.map(() => '?').join(', ');
  const retainedChunks = chunk(retained);
  const statements: D1PreparedStatement[] = [
    // R2 已删除：撤销台账。
    ...chunk(deleted).map((keys) => env.db.prepare(`DELETE FROM storage_cleanup_jobs WHERE r2_key IN (${inList(keys)})`).bind(...keys)),
    // R2 删除失败：保留台账等待重试。
    ...chunk(failed).map((keys) => env.db.prepare(`UPDATE storage_cleanup_jobs SET last_error = 'R2 cleanup failed; retry scheduled'
      WHERE r2_key IN (${inList(keys)})`).bind(...keys)),
    // 仍被引用的对象不删，只撤销台账；写入时复核引用仍在，引用若刚被删除则留给下一轮删除对象。
    ...retainedChunks.map((keys) => env.db.prepare(`DELETE FROM storage_cleanup_jobs WHERE r2_key IN (${inList(keys)})
      AND ${referencedSql('storage_cleanup_jobs.r2_key')}`).bind(...keys)),
  ];
  if (!statements.length) return 0;
  try {
    const results = await env.db.batch(statements);
    const retainedResults = results.slice(results.length - retainedChunks.length);
    return deleted.length + retainedResults.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  } catch (error) {
    // 台账仍在：已删除的对象下一轮重复删除是幂等的。
    console.error('R2 cleanup bookkeeping deferred:', error);
    return 0;
  }
}

const deferredCleanups = new WeakMap<ExecCtx, Promise<void>>();

/**
 * 用户请求里的 R2 清理：有 ctx 时放进 waitUntil，不阻塞响应；同一请求多次调用串行执行，
 * 后一次只处理前一次剩下的台账。没有 ctx 时同步完成。D1 元数据与台账在调用前已同一事务提交。
 */
export async function scheduleStorageCleanup(env: Env, ctx?: ExecCtx | null, limit = 100): Promise<void> {
  if (!ctx) {
    await processStorageCleanup(env, limit);
    return;
  }
  const next = (deferredCleanups.get(ctx) ?? Promise.resolve())
    .then(() => processStorageCleanup(env, limit))
    .then(() => undefined, (error: unknown) => { console.error('R2 cleanup deferred:', error); });
  deferredCleanups.set(ctx, next);
  ctx.waitUntil(next);
}

export async function expireExternalAttachmentLinks(env: Env): Promise<number> {
  const db = createDb(env);
  const rows = await db.select().from(externalAttachmentLinks).where(lt(externalAttachmentLinks.expiresAt, new Date())).limit(1000).all();
  for (const row of rows) {
    await db.batch([
      db.insert(storageCleanupJobs).values({ r2Key: row.r2Key }).onConflictDoNothing(),
      db.delete(externalAttachmentLinks).where(and(eq(externalAttachmentLinks.attachmentId, row.attachmentId), lt(externalAttachmentLinks.expiresAt, new Date()))),
    ]);
  }
  return rows.length;
}

/**
 * 指向已不存在邮件的附件行，按 id 从游标往后取一批（导出供 EXPLAIN 回归）。?1 游标 id、?2 当前时间、?3 批量。
 * 对象仍在有效投递租约里的跳过：发送流程收尾时自己删孤儿行并登记清理。
 */
export const ORPHAN_ATTACHMENTS_SQL = `SELECT id FROM attachments
  WHERE id > ?1 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = attachments.message_id)
    AND NOT EXISTS (SELECT 1 FROM delivery_object_leases WHERE delivery_object_leases.r2_key = attachments.r2_key
      AND delivery_object_leases.expires_at >= ?2)
  ORDER BY id LIMIT ?3`;

const ORPHAN_ATTACHMENT_BATCH = 200;
const ORPHAN_ATTACHMENT_MAX_BATCHES = 10;

/**
 * 每日维护：回收孤儿附件行（邮件在附件写入前被永久删除、或旧版本没有兜底时留下的）。
 * 对象 key 写进清理台账与删行在同一事务里，对象是否真删由 processStorageCleanup 按引用复核。
 * 每批沿 id 推进，单次最多 ORPHAN_ATTACHMENT_MAX_BATCHES 批；邮件 id 不复用，孤儿行不会重新有主。
 */
export async function purgeOrphanAttachments(env: Env): Promise<number> {
  let cursor = 0;
  let removed = 0;
  for (let batch = 0; batch < ORPHAN_ATTACHMENT_MAX_BATCHES; batch++) {
    const now = Date.now();
    const [, deleted] = await env.db.batch<{ id: number }>([
      env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
        SELECT r2_key FROM attachments WHERE id IN (${ORPHAN_ATTACHMENTS_SQL})`).bind(cursor, now, ORPHAN_ATTACHMENT_BATCH),
      env.db.prepare(`DELETE FROM attachments WHERE id IN (${ORPHAN_ATTACHMENTS_SQL}) RETURNING id`)
        .bind(cursor, now, ORPHAN_ATTACHMENT_BATCH),
    ]);
    const ids = (deleted?.results ?? []).map((row) => Number(row.id));
    removed += ids.length;
    if (ids.length < ORPHAN_ATTACHMENT_BATCH) break;
    cursor = Math.max(...ids);
  }
  return removed;
}

export async function expireDeliveryObjectLeases(env: Env): Promise<number> {
  const now = Date.now();
  const results = await env.db.batch([
    env.db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000').bind(now),
    env.db.prepare(`DELETE FROM attachments WHERE r2_key IN
      (SELECT r2_key FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = attachments.message_id)
      AND NOT EXISTS (SELECT 1 FROM delivery_object_leases WHERE delivery_object_leases.r2_key = attachments.r2_key AND expires_at >= ?)`)
      .bind(now, now),
    env.db.prepare(`DELETE FROM delivery_object_leases WHERE (r2_key, token) IN
      (SELECT r2_key, token FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000)`).bind(now),
  ]);
  return results[2]?.meta.changes ?? 0;
}
