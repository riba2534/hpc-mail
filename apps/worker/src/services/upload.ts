import { MAX_ATTACHMENT_TOTAL_BYTES, type AttachmentTokenRef } from '@hpc-mail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../types.js';
import { createDb } from '../db/client.js';
import { draftAttachments } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { attachmentDisposition, type StoredAttachment } from './outbound.js';

/** 草稿附件 R2 key：draft/{userId}/{token}。发送后附件行直接引用这个对象，草稿行删除、对象保留 */
export function draftKey(userId: number, token: string): string {
  return `draft/${userId}/${token}`;
}

/** 生成对外引用 token（前端上传后持有，发送时回传） */
export function newDraftToken(): string {
  return crypto.randomUUID();
}

/**
 * 发送时按 token 解析草稿附件：校验归属 + ready + 合计大小，转成引用草稿对象的 StoredAttachment。
 * 不读 R2：站内互投与超限转下载链接都用不到内容，需要内联进外发 MIME 时才由 sendMail 按需读取。
 * 任意 token 不存在 / 不归属 / 未完成上传 → 抛错（防止漏发附件或越权引用他人草稿）。
 * 同一 token 引用多次时以第一次的内联参数为准。
 */
export async function resolveDraftAttachments(
  env: Env,
  userId: number,
  refs: (string | AttachmentTokenRef)[],
): Promise<StoredAttachment[]> {
  const byToken = new Map<string, AttachmentTokenRef>();
  for (const ref of refs) {
    const value = typeof ref === 'string' ? { token: ref } : ref;
    if (!byToken.has(value.token)) byToken.set(value.token, value);
  }
  if (byToken.size === 0) return [];
  const db = createDb(env);
  const rows = await db
    .select()
    .from(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, [...byToken.keys()])))
    .all();
  const rowByToken = new Map(rows.map((r) => [r.token, r]));

  let declaredTotal = 0;
  const out: StoredAttachment[] = [];
  for (const [token, ref] of byToken) {
    const row = rowByToken.get(token);
    if (!row) throw new AppError('validation_failed', `附件不存在或无权使用：${token}`);
    if (row.status !== 'ready') {
      throw new AppError('validation_failed', `附件尚未上传完成：${row.filename}`);
    }
    declaredTotal += row.size;
    out.push({
      filename: row.filename,
      mimeType: row.mimeType,
      contentId: ref.contentId ?? '',
      disposition: attachmentDisposition(ref),
      r2Key: row.r2Key,
      size: row.size,
    });
  }
  if (declaredTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError(
      'payload_too_large',
      `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
    );
  }
  return out;
}

/**
 * 发送成功后回收草稿：只删 draft_attachments 行。对象已被发件行与站内副本的附件行直接引用，
 * 随邮件的删除进入清理台账，最后一个引用消失时才删除。
 */
export async function consumeDraftAttachments(
  env: Env,
  userId: number,
  tokens: string[],
): Promise<void> {
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return;
  await createDb(env)
    .delete(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, uniq)));
}

/**
 * 释放已完成上传（或从未开始分片）的草稿：同一事务里删行并登记清理台账。对象可能已被发出
 * （包括全部失败而保留的）邮件附件引用，由 processStorageCleanup 按引用判断是否真删。ids 不超过 90 个。
 */
export function releaseDraftStatements(env: Env, ids: number[]): D1PreparedStatement[] {
  const marks = ids.map(() => '?').join(', ');
  return [
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE id IN (${marks})`).bind(...ids),
    env.db.prepare(`DELETE FROM draft_attachments WHERE id IN (${marks})`).bind(...ids),
  ];
}
