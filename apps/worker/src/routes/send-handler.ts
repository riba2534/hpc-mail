import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_SEND_REQUEST_BYTES,
  internalSendMailSchema,
  isUrlAttachment,
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
  type DecodedAttachment,
  type Sender,
} from '../services/outbound.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import { fetchUrlAttachments, releaseUrlAttachments, type FetchedUrlAttachment } from '../services/url-attachment.js';
import type { AppContext, Env, ExecCtx } from '../types.js';

/** 发一封信所需的请求环境（与 Hono Context 无关，单发与批量共用） */
export interface SendEnvironment {
  env: Env;
  ctx: ExecCtx;
  /** 请求 origin：附件下载链接的回退值（优先 env.site_origin） */
  origin: string;
  /** 本站自身的主机名：URL 附件不能指向它们 */
  selfHosts: string[];
}

export function sendEnvironment(c: Context<AppContext>): SendEnvironment {
  const url = new URL(c.req.url);
  return { env: c.env, ctx: c.executionCtx, origin: url.origin, selfHosts: selfHostsOf(c) };
}

/** 本站自身的主机名：请求主机与 env.site_origin 的主机 */
export function selfHostsOf(c: Context<AppContext>): string[] {
  const hosts = [new URL(c.req.url).hostname];
  if (c.env.site_origin) {
    try { hosts.push(new URL(c.env.site_origin).hostname); } catch { /* 配置错误时只拦请求主机 */ }
  }
  return hosts;
}

/** 发信请求体超过上限时在解析前拒绝：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容 */
export function assertSendBodySize(c: Context<AppContext>): void {
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
}

/** 全部收件人被明确拒收为 422（首次与同 Key 重放一致），其余（含部分失败、结果未确认的 unknown）照常返回 */
export function settledResult(summary: MessageSummary): MessageSummary {
  if (summary.status === 'failed') {
    throw deliveryFailedError(summary.id, summary.recipientOutcomes ?? [], summary.errorDetail || '全部收件人投递失败');
  }
  return summary;
}

/** 三种附件来源合并：attachments[]（base64 与 URL 按原顺序）在前，上传 token 在后 */
async function prepareAttachments(
  se: SendEnvironment,
  sender: Sender,
  req: InternalSendMailRequest,
  leaseToken: string,
  fetched: FetchedUrlAttachment[],
): Promise<DecodedAttachment[]> {
  const decoded = decodeInlineAttachments(req.attachments.filter((item) => !isUrlAttachment(item)));
  const tokens = await resolveDraftAttachments(se.env, sender.userId, req.attachmentTokens, leaseToken);
  const used = [...decoded, ...tokens].reduce((sum, att) => sum + ('bytes' in att ? att.bytes.byteLength : att.size), 0);
  fetched.push(...await fetchUrlAttachments(se.env, sender.userId, req.attachments.filter(isUrlAttachment), {
    selfHosts: se.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - used,
  }));
  let inline = 0;
  let remote = 0;
  const ordered = req.attachments.map((item): DecodedAttachment => (isUrlAttachment(item) ? fetched[remote++]! : decoded[inline++]!));
  return [...ordered, ...tokens];
}

/**
 * 发一封信：幂等占位 → 准备附件（base64、上传 token、URL 拉取）→ sendMail（投递结束时回填幂等结果、释放租约）
 * → 回收附件。失败抛 AppError（与单发的 HTTP 错误相同）；全部收件人失败时首次与重放都抛 422。
 */
export async function sendOne(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  req: InternalSendMailRequest,
  idempotencyKey: string | undefined,
): Promise<MessageSummary> {
  const idem = await beginIdempotentSend(se.env, actor, idempotencyKey, sendRequestFingerprint(req));
  if (idem.kind === 'replay') return settledResult(idem.response);
  // 本次发送引用的草稿与原附件都登记在这个租约下，投递结束时释放
  const leaseToken = crypto.randomUUID();
  // 拉取转存的 URL 附件不归调用方持有：无论结果如何都在本次请求里回收（已发出的邮件按附件行引用保留对象）
  const fetched: FetchedUrlAttachment[] = [];
  let summary: MessageSummary;
  try {
    const attachments = await prepareAttachments(se, sender, req, leaseToken, fetched);
    summary = await sendMail(se.env, se.ctx, sender, req, attachments, se.origin, idem.handle, leaseToken);
  } catch (error) {
    // 投递开始后 sendMail 不再抛错（全部失败也返回结果）；这里是投递前的异常，幂等记录按错误类型删除或标 failed，租约随之释放。
    // 同 Key 重试会重新拉取 URL 附件
    await Promise.all([
      failIdempotentSend(se.env, idem.handle, error),
      releaseDeliveryLeases(se.env, leaseToken),
      releaseUrlAttachments(se.env, sender.userId, fetched),
    ]);
    throw error;
  }
  // 全部失败不回收上传附件：同一 token 修正后可以再发。其余结果下邮件可能已发出，回收失败不能翻转请求结果
  // （前端会提示重发，token 又还在，收件人就收到两封），留给 24h 的草稿清理兜底
  const consumed = [...(summary.status !== 'failed' ? req.attachmentTokens.map((ref) => ref.token) : []), ...fetched.map((att) => att.token)];
  await consumeDraftAttachments(se.env, sender.userId, consumed)
    .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error));
  return settledResult(summary);
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
  assertSendBodySize(c);
  const req = await parseBody(c, internalSendMailSchema);
  authorize?.(req);
  const summary = await sendOne(sendEnvironment(c), actor, sender, req, c.req.header('Idempotency-Key'));
  return ok(c, summary, 201);
}
