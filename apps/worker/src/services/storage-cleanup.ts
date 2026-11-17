import { chunk } from '../lib/d1.js';
import type { Env, ExecCtx } from '../types.js';

/** R2 批量删除单次最多 1000 个 key */
const R2_DELETE_BATCH = 1000;

/**
 * 对象仍被引用：附件行、正文溢出、原始 .eml、90 天外链、尚未发送的上传附件（发信直接引用草稿对象）或服务端草稿的正文。
 * 每个子查询各走自己的 r2_key 索引。
 */
const referencedSql = (key: string) => `(EXISTS (SELECT 1 FROM attachments WHERE attachments.r2_key = ${key})
  OR EXISTS (SELECT 1 FROM messages WHERE messages.body_r2_key = ${key})
  OR EXISTS (SELECT 1 FROM messages WHERE messages.raw_r2_key = ${key})
  OR EXISTS (SELECT 1 FROM external_attachment_links WHERE external_attachment_links.r2_key = ${key})
  OR EXISTS (SELECT 1 FROM draft_attachments WHERE draft_attachments.r2_key = ${key})
  OR EXISTS (SELECT 1 FROM drafts WHERE drafts.body_r2_key = ${key}))`;

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

/**
 * 过期的 90 天外链：对象 key 写进清理台账、删除外链行，两条语句同一个 batch（一次往返、同一事务），
 * 按同一时间点与同一顺序各取最早的 1000 条，选中的是同一批行。原先逐行各一个 batch，最多 1000 次往返。
 * 对象是否真删由 processStorageCleanup 按引用复核（邮件或附件行仍引用时保留）。
 */
export const EXPIRED_LINKS_SQL = `SELECT attachment_id FROM external_attachment_links WHERE expires_at < ?
  ORDER BY expires_at, attachment_id LIMIT 1000`;

export async function expireExternalAttachmentLinks(env: Env): Promise<number> {
  const now = Date.now();
  const [, deleted] = await env.db.batch([
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
      SELECT r2_key FROM external_attachment_links WHERE attachment_id IN (${EXPIRED_LINKS_SQL})`).bind(now),
    env.db.prepare(`DELETE FROM external_attachment_links WHERE attachment_id IN (${EXPIRED_LINKS_SQL})`).bind(now),
  ]);
  return deleted?.meta.changes ?? 0;
}

/**
 * 指向已不存在邮件的附件行，在 id 区间 (?1, ?2] 里按 id 取一批（导出供 EXPLAIN 回归）。?3 当前时间、?4 批量。
 * 对象仍在有效投递租约里的跳过：发送流程收尾时自己删孤儿行并登记清理。
 */
export const ORPHAN_ATTACHMENTS_SQL = `SELECT id FROM attachments
  WHERE id > ?1 AND id <= ?2 AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = attachments.message_id)
    AND NOT EXISTS (SELECT 1 FROM delivery_object_leases WHERE delivery_object_leases.r2_key = attachments.r2_key
      AND delivery_object_leases.expires_at >= ?3)
  ORDER BY id LIMIT ?4`;

const ORPHAN_ATTACHMENT_BATCH = 200;
const ORPHAN_ATTACHMENT_MAX_BATCHES = 10;
/** 孤儿扫描的检查点：上次扫到的附件 id（KV，每天读写一次，最终一致足够） */
export const ORPHAN_SCAN_CURSOR_KEY = 'orphan-attachments:cursor';
/** 每天只扫检查点之后这么多个 id，扫到表尾回到开头：整表一轮分摊到多天，不再每天全表扫两遍 */
export const ORPHAN_SCAN_IDS = 20_000;

/**
 * 每日维护：回收孤儿附件行（邮件在附件写入前被永久删除、或旧版本没有兜底时留下的）。
 * 对象 key 写进清理台账与删行在同一事务里，对象是否真删由 processStorageCleanup 按引用复核。
 * 每次从检查点扫 ORPHAN_SCAN_IDS 个 id 的区间，区间内每批沿 id 推进、最多 ORPHAN_ATTACHMENT_MAX_BATCHES 批；
 * 批数用尽时下次从删到的位置接着扫。邮件 id 不复用，孤儿行不会重新有主，晚几天回收无妨。
 */
export async function purgeOrphanAttachments(env: Env): Promise<number> {
  const start = Number(await env.kv.get(ORPHAN_SCAN_CURSOR_KEY)) || 0;
  const end = start + ORPHAN_SCAN_IDS;
  let cursor = start;
  let removed = 0;
  let maxId = 0;
  let rangeDone = false;
  for (let batch = 0; batch < ORPHAN_ATTACHMENT_MAX_BATCHES; batch++) {
    const now = Date.now();
    const [, deleted, last] = await env.db.batch<{ id: number | null }>([
      env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
        SELECT r2_key FROM attachments WHERE id IN (${ORPHAN_ATTACHMENTS_SQL})`).bind(cursor, end, now, ORPHAN_ATTACHMENT_BATCH),
      env.db.prepare(`DELETE FROM attachments WHERE id IN (${ORPHAN_ATTACHMENTS_SQL}) RETURNING id`)
        .bind(cursor, end, now, ORPHAN_ATTACHMENT_BATCH),
      env.db.prepare('SELECT MAX(id) AS id FROM attachments'),
    ]);
    maxId = Number(last?.results[0]?.id ?? 0);
    const ids = (deleted?.results ?? []).map((row) => Number(row.id));
    removed += ids.length;
    if (ids.length < ORPHAN_ATTACHMENT_BATCH) {
      rangeDone = true;
      break;
    }
    cursor = Math.max(...ids);
  }
  const next = !rangeDone ? cursor : end >= maxId ? 0 : end;
  await env.kv.put(ORPHAN_SCAN_CURSOR_KEY, String(next));
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
