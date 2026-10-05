import { and, eq, gt, lt, or } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments, deliveryObjectLeases, externalAttachmentLinks, messages, storageCleanupJobs } from '../db/schema.js';
import type { Env } from '../types.js';

/** Retained delivery links and other live messages always keep their shared objects. */
export async function processStorageCleanup(env: Env, limit = 100): Promise<number> {
  const db = createDb(env);
  let jobs: typeof storageCleanupJobs.$inferSelect[];
  try { jobs = await db.select().from(storageCleanupJobs).limit(limit).all(); }
  catch (error) { console.error('R2 cleanup query deferred:', error); return 0; }
  let cleaned = 0;
  for (const job of jobs) {
    try {
      const activeLease = await db.select({ token: deliveryObjectLeases.token }).from(deliveryObjectLeases)
        .where(and(eq(deliveryObjectLeases.r2Key, job.r2Key), gt(deliveryObjectLeases.expiresAt, new Date()))).get();
      if (activeLease) continue; // Keep the durable job until the in-flight delivery releases its lease.
      const [attachment, message, link] = await Promise.all([
        db.select({ id: attachments.id }).from(attachments).where(eq(attachments.r2Key, job.r2Key)).get(),
        db.select({ id: messages.id }).from(messages).where(or(eq(messages.bodyR2Key, job.r2Key), eq(messages.rawR2Key, job.r2Key))).get(),
        db.select({ id: externalAttachmentLinks.attachmentId }).from(externalAttachmentLinks).where(eq(externalAttachmentLinks.r2Key, job.r2Key)).get(),
      ]);
      if (!attachment && !message && !link) await env.r2.delete(job.r2Key);
      await db.delete(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, job.r2Key));
      cleaned++;
    } catch (error) {
      console.error('R2 cleanup deferred:', error);
      try { await db.update(storageCleanupJobs).set({ lastError: 'R2 cleanup failed; retry scheduled' }).where(eq(storageCleanupJobs.r2Key, job.r2Key)); } catch { /* the existing durable job still retains its key */ }
    }
  }
  return cleaned;
}

export async function expireExternalAttachmentLinks(env: Env): Promise<void> {
  const db = createDb(env);
  const rows = await db.select().from(externalAttachmentLinks).where(lt(externalAttachmentLinks.expiresAt, new Date())).limit(1000).all();
  for (const row of rows) {
    await db.batch([
      db.insert(storageCleanupJobs).values({ r2Key: row.r2Key }).onConflictDoNothing(),
      db.delete(externalAttachmentLinks).where(and(eq(externalAttachmentLinks.attachmentId, row.attachmentId), lt(externalAttachmentLinks.expiresAt, new Date()))),
    ]);
  }
}

export async function expireDeliveryObjectLeases(env: Env): Promise<void> {
  const now = Date.now();
  await env.db.batch([
    env.db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000').bind(now),
    env.db.prepare(`DELETE FROM attachments WHERE r2_key IN
      (SELECT r2_key FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = attachments.message_id)
      AND NOT EXISTS (SELECT 1 FROM delivery_object_leases WHERE delivery_object_leases.r2_key = attachments.r2_key AND expires_at >= ?)`)
      .bind(now, now),
    env.db.prepare(`DELETE FROM delivery_object_leases WHERE (r2_key, token) IN
      (SELECT r2_key, token FROM delivery_object_leases WHERE expires_at < ? ORDER BY expires_at, r2_key, token LIMIT 1000)`).bind(now),
  ]);
}
