import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_DRAFT_ATTACHMENTS_PER_USER,
  MAX_DRAFT_ATTACHMENT_BYTES_PER_USER,
  type AttachmentTokenRef,
} from '@hpc-mail/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Env } from '../types.js';
import { createDb } from '../db/client.js';
import { deliveryObjectLeases, draftAttachments } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { attachmentDisposition, leaseColumns, type StoredAttachment } from './outbound.js';

/** 草稿附件 R2 key：draft/{userId}/{token}。发送后附件行直接引用这个对象，草稿行删除、对象保留 */
export function draftKey(userId: number, token: string): string {
  return `draft/${userId}/${token}`;
}

/** 生成对外引用 token（前端上传后持有，发送时回传） */
export function newDraftToken(): string {
  return crypto.randomUUID();
}

/**
 * 原子占用一行上传附件（status 默认 uploading），同时检查每人待发送附件的个数与合计大小配额，返回行 id。
 * 先落 D1 占位行再写 R2：反过来的话，put 成功而 insert 失败就留下一个没有任何行指向的 R2 对象，
 * 而清理任务是遍历 draft_attachments 表的，永远扫不到它。服务端草稿引用的附件同样计入这份配额。
 */
export async function reserveDraftAttachment(
  env: Env,
  input: { userId: number; token: string; filename: string; mimeType: string; size: number; r2Key: string; status?: 'uploading' | 'ready' },
): Promise<number> {
  const inserted = await env.db
    .prepare(
      `INSERT INTO draft_attachments
        (user_id, token, filename, mime_type, size, r2_key, status)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM draft_attachments WHERE user_id = ?) < ?
         AND COALESCE((SELECT SUM(size) FROM draft_attachments WHERE user_id = ?), 0) + ? <= ?
       RETURNING id`,
    )
    .bind(
      input.userId, input.token, input.filename, input.mimeType, input.size, input.r2Key, input.status ?? 'uploading',
      input.userId, MAX_DRAFT_ATTACHMENTS_PER_USER,
      input.userId, input.size, MAX_DRAFT_ATTACHMENT_BYTES_PER_USER,
    )
    .first<{ id: number }>();
  if (!inserted) {
    throw new AppError(
      'rate_limited',
      `待发送附件最多 ${MAX_DRAFT_ATTACHMENTS_PER_USER} 个、合计 ${Math.floor(MAX_DRAFT_ATTACHMENT_BYTES_PER_USER / 1024 / 1024)}MB`,
      { fix: '先发送或删除旧草稿、取消未用的上传（DELETE /uploads/:token），再重试' },
    );
  }
  return inserted.id;
}

/**
 * 发送时按 token 解析草稿附件：校验归属 + ready + 合计大小，转成引用草稿对象的 StoredAttachment。
 * 读草稿行与为 ready 草稿登记投递租约（leaseToken）在同一个 batch 里：之后草稿被删除或到期，对象也要等投递结束才回收。
 * 被服务端草稿引用（draft_id 非空）的附件只能由该草稿使用：options.draftId 为发送中的草稿 id，
 * 不传（直接发信）时只接受没有被草稿引用的附件。
 * 不读 R2：站内互投与超限转下载链接都用不到内容，需要内联进外发 MIME 时才由 sendMail 按需读取。
 * 任意 token 不存在 / 不归属 / 未完成上传 → 抛错（防止漏发附件或越权引用他人草稿），已登记的租约由调用方释放。
 * 同一 token 引用多次时以第一次的内联参数为准。
 */
export async function resolveDraftAttachments(
  env: Env,
  userId: number,
  refs: (string | AttachmentTokenRef)[],
  leaseToken: string,
  options: { draftId?: number } = {},
): Promise<StoredAttachment[]> {
  const byToken = new Map<string, AttachmentTokenRef>();
  for (const ref of refs) {
    const value = typeof ref === 'string' ? { token: ref } : ref;
    if (!byToken.has(value.token)) byToken.set(value.token, value);
  }
  if (byToken.size === 0) return [];
  const db = createDb(env);
  const owned = and(
    eq(draftAttachments.userId, userId),
    inArray(draftAttachments.token, [...byToken.keys()]),
    options.draftId === undefined
      ? isNull(draftAttachments.draftId)
      : or(isNull(draftAttachments.draftId), eq(draftAttachments.draftId, options.draftId)),
  );
  const [, rows] = await db.batch([
    db.insert(deliveryObjectLeases)
      .select(db.select(leaseColumns(draftAttachments.r2Key, leaseToken)).from(draftAttachments)
        .where(and(owned, eq(draftAttachments.status, 'ready'))))
      .onConflictDoNothing(),
    db.select().from(draftAttachments).where(owned),
  ]);
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
 * 删除草稿行并在同一事务里登记清理台账。对象可能已被发出（包括全部失败而保留的）邮件的附件行直接引用，
 * 由 processStorageCleanup 按引用判断是否真删；绑定参数不超过 90 个。
 */
function releaseDrafts(env: Env, where: string, params: unknown[]): D1PreparedStatement[] {
  return [
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE ${where}`).bind(...params),
    env.db.prepare(`DELETE FROM draft_attachments WHERE ${where}`).bind(...params),
  ];
}

/** 过期或手动删除的草稿（已完成上传，或从未开始分片） */
export function releaseDraftStatements(env: Env, ids: number[]): D1PreparedStatement[] {
  return releaseDrafts(env, `id IN (${ids.map(() => '?').join(', ')})`, ids);
}

/**
 * 发送成功后回收草稿：只删草稿行，对象留给发件行与站内副本的附件行引用，随邮件删除进入清理；
 * 发送途中发件记录已被永久删除的，靠这里登记的台账回收。
 */
export async function consumeDraftAttachments(
  env: Env,
  userId: number,
  tokens: string[],
): Promise<void> {
  const uniq = [...new Set(tokens)];
  if (uniq.length === 0) return;
  await env.db.batch(releaseDrafts(env, `user_id = ? AND token IN (${uniq.map(() => '?').join(', ')})`, [userId, ...uniq]));
}
