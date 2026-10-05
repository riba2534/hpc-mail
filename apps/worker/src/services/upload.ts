import { MAX_ATTACHMENT_TOTAL_BYTES } from '@hpc-mail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../types.js';
import { createDb } from '../db/client.js';
import { draftAttachments } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { DecodedAttachment } from './outbound.js';

/** 草稿附件 R2 key：draft/{userId}/{token}（发送成功后内容迁移到 att/{messageId}/，此处删除） */
export function draftKey(userId: number, token: string): string {
  return `draft/${userId}/${token}`;
}

/** 生成对外引用 token（前端上传后持有，发送时回传） */
export function newDraftToken(): string {
  return crypto.randomUUID();
}

/**
 * 发送时按 token 解析草稿附件：校验归属 + ready，从 R2 读回 bytes，转成 DecodedAttachment
 * 供 sendMail 组装 MIME / 持久化。任意 token 不存在 / 不归属 / 未完成上传 → 抛错
 * （防止漏发附件或越权引用他人草稿）。
 */
export async function resolveDraftAttachments(
  env: Env,
  userId: number,
  tokens: string[],
): Promise<DecodedAttachment[]> {
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return [];
  const db = createDb(env);
  const rows = await db
    .select()
    .from(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, uniq)))
    .all();
  const byToken = new Map(rows.map((r) => [r.token, r]));

  // 先用 D1 里的 size 列把总量拦下来，再去 R2 取内容：每个附件都要整包读进内存
  // （50MB 二进制 + 转 base64 时的临时串就逼近 Workers 128MB isolate 上限），
  // 等读完再校验等于没校验
  let declaredTotal = 0;
  for (const token of uniq) {
    const row = byToken.get(token);
    if (!row) throw new AppError('validation_failed', `附件不存在或无权使用：${token}`);
    if (row.status !== 'ready') {
      throw new AppError('validation_failed', `附件尚未上传完成：${row.filename}`);
    }
    declaredTotal += row.size;
  }
  if (declaredTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError(
      'payload_too_large',
      `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
    );
  }

  const out: DecodedAttachment[] = [];
  for (const token of uniq) {
    const row = byToken.get(token)!;
    const obj = await env.r2.get(row.r2Key);
    if (!obj) throw new AppError('not_found', `附件内容不存在：${row.filename}`);
    // base64 不在这里算：超限转下载链接时附件根本不进 MIME，提前算纯属多占一份内存
    out.push({
      filename: row.filename,
      mimeType: row.mimeType,
      contentId: '',
      disposition: 'attachment',
      bytes: new Uint8Array(await obj.arrayBuffer()),
    });
  }
  return out;
}

/**
 * 发送成功后回收草稿附件：内容已由 sendMail 的 persistAttachments 复制到 att/{messageId}/，
 * 这里删除 draft/ 的 R2 对象 + draft_attachments 行，避免孤儿占用。R2 删除失败不阻断主流程。
 */
export async function consumeDraftAttachments(
  env: Env,
  userId: number,
  tokens: string[],
): Promise<void> {
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return;
  const db = createDb(env);
  const rows = await db
    .select({ id: draftAttachments.id, r2Key: draftAttachments.r2Key })
    .from(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, uniq)))
    .all();
  const cleaned: number[] = [];
  for (const r of rows) {
    try {
      await env.r2.delete(r.r2Key);
      cleaned.push(r.id);
    } catch (e) {
      console.error('删除草稿附件 R2 失败:', e);
    }
  }
  if (cleaned.length) {
    await db.delete(draftAttachments).where(inArray(draftAttachments.id, cleaned));
  }
}
