import {
  MAX_ATTACHMENT_FILE_BYTES,
  SINGLE_UPLOAD_THRESHOLD_BYTES,
  MULTIPART_PART_BYTES,
  attachmentFilenameSchema,
  completeMultipartUploadSchema,
  initMultipartUploadSchema,
  type CompleteMultipartUploadRequest,
  type InitMultipartUploadRequest,
} from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { createDb } from '../db/client.js';
import { draftAttachments } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { execCtx, ok, parseBody, parseId } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { scheduleStorageCleanup } from '../services/storage-cleanup.js';
import { draftKey, newDraftToken, releaseDraftStatements, reserveDraftAttachment } from '../services/upload.js';
import type { AppContext } from '../types.js';

function uploadOwner(c: Context<AppContext>): { id: number } {
  const id = c.get('user')?.id ?? c.get('apiKey')?.userId;
  if (!id) throw new AppError('unauthorized', '缺少访问令牌');
  return { id };
}

/** 同一上传实现支持 JWT 和带 mail.send 的 API Key，所有草稿始终绑定真实账号 id。 */
export function createUploadRoutes(authentication: MiddlewareHandler<AppContext>, authorize?: MiddlewareHandler<AppContext>) {
  const app = new Hono<AppContext>();
  app.use('*', authentication);
  if (authorize) app.use('*', authorize);

  /** 单片流式直传：filename/mimeType 走 query，二进制内容走 body → R2 put 流式 */
  app.post('/', async (c) => {
    const user = uploadOwner(c);
    const filenameParsed = attachmentFilenameSchema.safeParse(c.req.query('filename'));
    if (!filenameParsed.success) throw new AppError('validation_failed', '文件名非法');
    const mimeType = (c.req.query('mimeType') || 'application/octet-stream').trim().slice(0, 128) ||
      'application/octet-stream';
    const declaredSize = Number(c.req.header('content-length') || '0');
    if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
      throw new AppError('validation_failed', '缺少 Content-Length');
    }
    if (declaredSize > MAX_ATTACHMENT_FILE_BYTES) {
      throw new AppError(
        'payload_too_large',
        `单文件超过 ${Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB 上限`,
      );
    }
    if (declaredSize > SINGLE_UPLOAD_THRESHOLD_BYTES) {
      throw new AppError('payload_too_large', '文件较大，请改用分片上传');
    }
    const token = newDraftToken();
    const key = draftKey(user.id, token);
    const stream = c.req.raw.body;
    if (!stream) throw new AppError('validation_failed', '上传内容为空');
    const db = createDb(c.env);
    // 先落 D1 占位行再写 R2：反过来的话，put 成功而 insert 失败就留下一个没有任何行指向的
    // R2 对象，而清理任务是遍历 draft_attachments 表的，永远扫不到它 → 永久计费
    const draftId = await reserveDraftAttachment(c.env, {
      userId: user.id,
      token,
      filename: filenameParsed.data,
      mimeType,
      size: declaredSize,
      r2Key: key,
    });
    try {
      const stored = await c.env.r2.put(key, stream, { httpMetadata: { contentType: mimeType } });
      if (stored.size !== declaredSize) {
        await c.env.r2.delete(key);
        throw new AppError('validation_failed', '上传大小与 Content-Length 不一致');
      }
    } catch (e) {
      await db.delete(draftAttachments).where(eq(draftAttachments.id, draftId));
      throw e;
    }
    await db
      .update(draftAttachments)
      .set({ status: 'ready' })
      .where(eq(draftAttachments.token, token));
    return ok(c, { token, filename: filenameParsed.data, size: declaredSize, mimeType }, 201);
  });

  /** 大文件分片上传：初始化（创建 R2 multipart upload，返回 uploadId + 分片参数） */
  app.post('/multipart', async (c) => {
    const user = uploadOwner(c);
    const req = await parseBody<InitMultipartUploadRequest>(c, initMultipartUploadSchema);
    const token = newDraftToken();
    const key = draftKey(user.id, token);
    const db = createDb(c.env);
    // 同单片直传：先占位行再建 multipart upload，避免 create 成功、insert 失败时
    // uploadId 丢失——R2 binding 没有 list-multipart-uploads，丢了就再也 abort 不掉
    const draftId = await reserveDraftAttachment(c.env, {
      userId: user.id,
      token,
      filename: req.filename,
      mimeType: req.mimeType,
      size: req.size,
      r2Key: key,
    });
    let mpu;
    try {
      mpu = await c.env.r2.createMultipartUpload(key, {
        httpMetadata: { contentType: req.mimeType },
      });
    } catch (e) {
      await db.delete(draftAttachments).where(eq(draftAttachments.id, draftId));
      throw e;
    }
    await db
      .update(draftAttachments)
      .set({ uploadId: mpu.uploadId })
      .where(eq(draftAttachments.token, token));
    return ok(
      c,
      {
        token,
        uploadId: mpu.uploadId,
        partBytes: MULTIPART_PART_BYTES,
        partCount: Math.ceil(req.size / MULTIPART_PART_BYTES),
      },
      201,
    );
  });

  /** 上传一个分片：body 流式 → R2 uploadPart，记录 {partNumber, etag} */
  app.put('/multipart/:token/parts/:partNumber', async (c) => {
    const user = uploadOwner(c);
    const token = c.req.param('token');
    const partNumber = parseId(c.req.param('partNumber'));
    if (partNumber > 10000) throw new AppError('validation_failed', '分片编号过大');
    const db = createDb(c.env);
    const row = await db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get();
    if (!row || row.userId !== user.id) throw new AppError('not_found', '上传会话不存在');
    // 分片编号不能超出声明大小对应的片数：配合 complete 处的真实大小校验，
    // 两层一起堵住「声明 1 字节、实际灌几百 GB」
    if (partNumber > Math.ceil(row.size / MULTIPART_PART_BYTES)) {
      throw new AppError('validation_failed', '分片编号超出声明的文件大小');
    }
    if (row.status !== 'uploading' || !row.uploadId) {
      throw new AppError('validation_failed', '该上传会话不可续传');
    }
    const expectedSize = Math.min(
      MULTIPART_PART_BYTES,
      row.size - (partNumber - 1) * MULTIPART_PART_BYTES,
    );
    const declaredSize = Number(c.req.header('content-length') || '0');
    if (!Number.isInteger(declaredSize) || declaredSize !== expectedSize) {
      throw new AppError('validation_failed', `第 ${partNumber} 片大小应为 ${expectedSize} 字节`);
    }
    const stream = c.req.raw.body;
    if (!stream) throw new AppError('validation_failed', '分片内容为空');
    const part = await c.env.r2.resumeMultipartUpload(row.r2Key, row.uploadId).uploadPart(partNumber, stream);
    const parts = [
      ...(row.parts ?? []).filter((item) => item.partNumber !== partNumber),
      { partNumber, etag: part.etag },
    ];
    await db.update(draftAttachments).set({ parts }).where(eq(draftAttachments.id, row.id));
    return ok(c, { partNumber, etag: part.etag });
  });

  /** 完成分片上传：按 partNumber 升序提交所有 parts，触发 R2 complete */
  app.post('/multipart/:token/complete', async (c) => {
    const user = uploadOwner(c);
    const token = c.req.param('token');
    const req = await parseBody<CompleteMultipartUploadRequest>(c, completeMultipartUploadSchema);
    const db = createDb(c.env);
    const row = await db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get();
    if (!row || row.userId !== user.id) throw new AppError('not_found', '上传会话不存在');
    if (row.status !== 'uploading' || !row.uploadId) {
      throw new AppError('validation_failed', '该上传会话不可完成');
    }
    const parts = [...req.parts].sort((a, b) => a.partNumber - b.partNumber);
    const expectedParts = Math.ceil(row.size / MULTIPART_PART_BYTES);
    if (
      parts.length !== expectedParts ||
      parts.some((part, index) => part.partNumber !== index + 1)
    ) {
      throw new AppError('validation_failed', '分片列表不完整或顺序非法');
    }
    const mpu = c.env.r2.resumeMultipartUpload(row.r2Key, row.uploadId);
    const obj = await mpu.complete(parts);
    // 到这里才知道真实大小：init 校验的是客户端**声明**的 size，uploadPart 不限单片也不限累计，
    // 只信声明值等于没有上限——任何登录用户都能靠 {size:1} + 猛灌分片在 R2 写出任意大的对象
    if (obj.size > MAX_ATTACHMENT_FILE_BYTES || obj.size !== row.size) {
      try {
        await c.env.r2.delete(row.r2Key);
      } catch (e) {
        console.error('超限分片对象删除失败:', e);
        // Keep a durable reference but never make this invalid upload sendable.
        await db.update(draftAttachments).set({ uploadId: null }).where(eq(draftAttachments.id, row.id));
        throw new AppError('payload_too_large', '附件大小不符合声明，清理将在后台重试');
      }
      await db.delete(draftAttachments).where(eq(draftAttachments.id, row.id));
      throw new AppError(
        'payload_too_large',
        obj.size > MAX_ATTACHMENT_FILE_BYTES
          ? `单文件超过 ${Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB 上限`
          : '上传完成后的文件大小与声明不一致',
      );
    }
    await db
      .update(draftAttachments)
      .set({ status: 'ready', size: obj.size, parts })
      .where(eq(draftAttachments.id, row.id));
    return ok(c, { token, size: obj.size });
  });

  /**
   * 删除草稿附件：未完成的 multipart 直接 abort；已完成的对象可能已被发出（含全部失败而保留）的邮件附件引用，
   * 删行同时登记清理台账，由清理任务按引用判断是否真删
   */
  app.delete('/:token', async (c) => {
    const user = uploadOwner(c);
    const token = c.req.param('token');
    const db = createDb(c.env);
    const row = await db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get();
    if (!row || row.userId !== user.id) throw new AppError('not_found', '上传会话不存在');
    // 服务端草稿引用中的附件归草稿管理：直接删掉会让草稿（可能已安排定时发送）到点缺附件
    if (row.draftId !== null) {
      throw new AppError('draft_state_conflict', `该附件属于草稿 #${row.draftId}，不能直接删除`, {
        fix: `通过 PATCH /drafts/${row.draftId} 修改 attachmentTokens 把它移出草稿，或删除整份草稿`,
        docs: '/references/drafts.md#附件',
      });
    }
    if (row.uploadId && row.status === 'uploading') {
      await c.env.r2.resumeMultipartUpload(row.r2Key, row.uploadId).abort();
      await db.delete(draftAttachments).where(eq(draftAttachments.id, row.id));
    } else {
      await c.env.db.batch(releaseDraftStatements(c.env, [row.id]));
      await scheduleStorageCleanup(c.env, execCtx(c));
    }
    return ok(c, { success: true });
  });

  return app;
}

export default createUploadRoutes(requireAuth);
