import {
  MAX_SEND_REQUEST_BYTES,
  internalSendMailSchema,
  sendRequestFingerprint,
  type InternalSendMailRequest,
  type MessageSummary,
} from '@hpc-mail/shared';
import type { Context } from 'hono';
import { AppError } from '../lib/errors.js';
import { ok, parseBody } from '../lib/http.js';
import {
  beginIdempotentSend,
  completeIdempotentSend,
  failIdempotentSend,
  type IdempotencyActor,
} from '../services/idempotency.js';
import { decodeInlineAttachments, deliveryFailedError, sendMail, type Sender } from '../services/outbound.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import type { AppContext } from '../types.js';

/**
 * /api/messages/send 与 POST /v1/messages 共用的发信处理。authorize 在解析出请求后、占用幂等键前调用
 * （/v1 引用来源邮件时追加 mail.read 校验）。
 */
export async function handleSend(
  c: Context<AppContext>,
  actor: IdempotencyActor,
  sender: Sender,
  authorize?: (req: InternalSendMailRequest) => void | Promise<void>,
): Promise<Response> {
  // 解析前拦下超大请求体：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
  const req = await parseBody(c, internalSendMailSchema);
  await authorize?.(req);
  const idem = await beginIdempotentSend(c.env, actor, c.req.header('Idempotency-Key'), sendRequestFingerprint(req));
  if (idem.kind === 'replay') {
    // 全部收件人失败的结果重放时与首次一样是 422；部分失败、unknown 等仍是 201
    const replay = idem.response;
    if (replay.status === 'failed') {
      throw deliveryFailedError(replay.id, replay.recipientOutcomes ?? [], replay.errorDetail || '全部收件人投递失败');
    }
    return ok(c, replay, 201);
  }
  let summary: MessageSummary;
  try {
    // 两种附件来源：base64 内联（AI/脚本）+ 上传 token（前端与大文件），合并后送 sendMail
    const attachments = [
      ...decodeInlineAttachments(req.attachments),
      ...await resolveDraftAttachments(c.env, sender.userId, req.attachmentTokens),
    ];
    summary = await sendMail(c.env, c.executionCtx, sender, req, attachments, new URL(c.req.url).origin, idem.handle);
  } catch (error) {
    // 全部失败（422）时幂等键已绑定发件行，这里不会动它，重放由发件行推出同样的结果
    await failIdempotentSend(c.env, idem.handle, error);
    throw error;
  }
  // 邮件已发出：结果缓存与草稿回收失败都不能翻转请求结果（前端会提示重发，token 又还在，收件人就收到两封）。
  // 草稿回收失败留给 24h 的草稿清理兜底；两者互不依赖，并行写
  await Promise.all([
    completeIdempotentSend(c.env, idem.handle, summary)
      .catch((error) => console.error('已投递邮件的幂等结果回填失败，保持原键以便查询:', error)),
    consumeDraftAttachments(c.env, sender.userId, req.attachmentTokens.map((ref) => ref.token))
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error)),
  ]);
  return ok(c, summary, 201);
}
