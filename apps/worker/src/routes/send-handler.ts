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
import {
  beginIdempotentSend,
  completeIdempotentSend,
  failIdempotentSend,
  type IdempotencyActor,
} from '../services/idempotency.js';
import { decodeInlineAttachments, deliveryFailedError, sendMail, type DecodedAttachment, type Sender } from '../services/outbound.js';
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
  const selfHosts = [url.hostname];
  if (c.env.site_origin) {
    try { selfHosts.push(new URL(c.env.site_origin).hostname); } catch { /* 配置错误时只拦请求主机 */ }
  }
  return { env: c.env, ctx: c.executionCtx, origin: url.origin, selfHosts };
}

/** 发信请求体超过上限时在解析前拒绝：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容 */
export function assertSendBodySize(c: Context<AppContext>): void {
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
}

/** 三种附件来源合并：attachments[]（base64 与 URL 按原顺序）在前，上传 token 在后 */
async function prepareAttachments(
  se: SendEnvironment,
  sender: Sender,
  req: InternalSendMailRequest,
): Promise<{ attachments: DecodedAttachment[]; fetched: FetchedUrlAttachment[] }> {
  const decoded = decodeInlineAttachments(req.attachments.filter((item) => !isUrlAttachment(item)));
  const tokens = await resolveDraftAttachments(se.env, sender.userId, req.attachmentTokens);
  const used = [...decoded, ...tokens].reduce((sum, att) => sum + ('bytes' in att ? att.bytes.byteLength : att.size), 0);
  const fetched = await fetchUrlAttachments(se.env, sender.userId, req.attachments.filter(isUrlAttachment), {
    selfHosts: se.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - used,
  });
  let inline = 0;
  let remote = 0;
  const ordered = req.attachments.map((item): DecodedAttachment => (isUrlAttachment(item) ? fetched[remote++]! : decoded[inline++]!));
  return { attachments: [...ordered, ...tokens], fetched };
}

/**
 * 发一封信：幂等占位 → 准备附件（base64、上传 token、URL 拉取）→ sendMail → 回填幂等结果、回收附件。
 * 失败抛 AppError（与单发的 HTTP 错误相同）；全部收件人失败的结果重放时同样抛 422。
 */
export async function sendOne(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  req: InternalSendMailRequest,
  idempotencyKey: string | undefined,
): Promise<MessageSummary> {
  const idem = await beginIdempotentSend(se.env, actor, idempotencyKey, sendRequestFingerprint(req));
  if (idem.kind === 'replay') {
    // 全部收件人失败的结果重放时与首次一样是 422；部分失败、unknown 等仍是 201
    const replay = idem.response;
    if (replay.status === 'failed') {
      throw deliveryFailedError(replay.id, replay.recipientOutcomes ?? [], replay.errorDetail || '全部收件人投递失败');
    }
    return replay;
  }
  let summary: MessageSummary;
  let fetched: FetchedUrlAttachment[] = [];
  try {
    const prepared = await prepareAttachments(se, sender, req);
    fetched = prepared.fetched;
    summary = await sendMail(se.env, se.ctx, sender, req, prepared.attachments, se.origin, idem.handle);
  } catch (error) {
    // 全部失败（422）时幂等键已绑定发件行，这里不会动它，重放由发件行推出同样的结果。
    // 拉取转存的 URL 附件不归调用方持有，立即释放（同 Key 重试会重新拉取）
    await Promise.all([failIdempotentSend(se.env, idem.handle, error), releaseUrlAttachments(se.env, sender.userId, fetched)]);
    throw error;
  }
  // 邮件已发出：结果缓存与草稿回收失败都不能翻转请求结果（前端会提示重发，token 又还在，收件人就收到两封）。
  // 草稿回收失败留给 24h 的草稿清理兜底；两者互不依赖，并行写
  await Promise.all([
    completeIdempotentSend(se.env, idem.handle, summary)
      .catch((error) => console.error('已投递邮件的幂等结果回填失败，保持原键以便查询:', error)),
    consumeDraftAttachments(se.env, sender.userId, [...req.attachmentTokens.map((ref) => ref.token), ...fetched.map((att) => att.token)])
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error)),
  ]);
  return summary;
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
