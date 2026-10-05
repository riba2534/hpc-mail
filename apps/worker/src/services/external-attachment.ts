import { and, eq, gt, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { externalAttachmentLinks } from '../db/schema.js';
import { signAttachment } from '../lib/crypto.js';
import type { Env } from '../types.js';

const LINK_TTL_SECONDS = 90 * 86400;
export async function retainExternalAttachments(
  env: Env,
  rows: { id: number; r2Key: string; filename: string; mimeType: string; size: number }[],
  origin: string,
): Promise<Map<number, string>> {
  const db = createDb(env);
  const links = new Map<number, string>();
  for (const row of rows) {
    const signed = await signAttachment(env.jwt_secret, row.id, LINK_TTL_SECONDS);
    await db.insert(externalAttachmentLinks).values({
      attachmentId: row.id, r2Key: row.r2Key, filename: row.filename,
      mimeType: row.mimeType, size: row.size, expiresAt: new Date(signed.exp * 1000),
    }).onConflictDoUpdate({ target: externalAttachmentLinks.attachmentId,
      set: { expiresAt: sql`max(${externalAttachmentLinks.expiresAt}, ${signed.exp * 1000})` } });
    links.set(row.id, `${origin}/api/attachments/${row.id}?exp=${signed.exp}&sig=${signed.sig}`);
  }
  return links;
}

export async function loadExternalAttachment(env: Env, id: number) {
  return createDb(env).select().from(externalAttachmentLinks)
    .where(and(eq(externalAttachmentLinks.attachmentId, id), gt(externalAttachmentLinks.expiresAt, new Date()))).get();
}
