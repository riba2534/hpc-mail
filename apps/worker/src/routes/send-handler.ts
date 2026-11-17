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
import { beginIdempotentSend, failIdempotentSend, type IdempotencyActor } from '../services/idempotency.js';
import {
  decodeInlineAttachments,
  deliveryFailedError,
  releaseDeliveryLeases,
  sendMail,
  type Sender,
} from '../services/outbound.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import type { AppContext } from '../types.js';

/** 首次响应与同 Key 重放共用：全部收件人被明确拒收为 422，其余（含部分失败、结果未确认的 unknown）为 201 */
function sendResult(c: Context<AppContext>, summary: MessageSummary): Response {
  if (summary.status === 'failed') {
    throw deliveryFailedError(summary.id, summary.recipientOutcomes ?? [], summary.errorDetail || '全部收件人投递失败');
  }
  return ok(c, summary, 201);
}

/**
 * /api/messages/send 与 POST /v1/messages 共用的发信处理。authorize 在解析出请求后、占用幂等键前调用
 * （/v1 引用来源邮件时追加 mail.read 校验）。
 */
export async function handleSend(
  c: Context<AppContext>,
  actor: IdempotencyActor,
  sender: Sender,
  authorize?: (req: InternalSendMailRequest) => void,
): Promise<Response> {
  // 解析前拦下超大请求体：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
  const req = await parseBody(c, internalSendMailSchema);
  authorize?.(req);
  const idem = await beginIdempotentSend(c.env, actor, c.req.header('Idempotency-Key'), sendRequestFingerprint(req));
  if (idem.kind === 'replay') return sendResult(c, idem.response);
  // 本次发送引用的草稿与原附件都登记在这个租约下，投递结束时释放
  const leaseToken = crypto.randomUUID();
  let summary: MessageSummary;
  try {
    // 两种附件来源：base64 内联（AI/脚本）+ 上传 token（前端与大文件），合并后送 sendMail
    const attachments = [
      ...decodeInlineAttachments(req.attachments),
      ...await resolveDraftAttachments(c.env, sender.userId, req.attachmentTokens, leaseToken),
    ];
    summary = await sendMail(c.env, c.executionCtx, sender, req, attachments, new URL(c.req.url).origin, idem.handle, leaseToken);
  } catch (error) {
    // 投递开始后 sendMail 不再抛错（全部失败也返回结果）；这里是投递前的异常，幂等记录按错误类型删除或标 failed，租约随之释放
    await Promise.all([failIdempotentSend(c.env, idem.handle, error), releaseDeliveryLeases(c.env, leaseToken)]);
    throw error;
  }
  // 全部失败不回收草稿：同一 token 修正后可以再发。其余结果下邮件可能已发出，草稿回收失败不能翻转请求结果
  // （前端会提示重发，token 又还在，收件人就收到两封），留给 24h 的草稿清理兜底
  if (summary.status !== 'failed') {
    await consumeDraftAttachments(c.env, sender.userId, req.attachmentTokens.map((ref) => ref.token))
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error));
  }
  return sendResult(c, summary);
}
