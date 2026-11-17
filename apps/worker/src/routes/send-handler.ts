import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_SEND_REQUEST_BYTES,
  composeRequestFingerprint,
  forwardMessageRequestSchema,
  internalSendMailSchema,
  isUrlAttachment,
  replyMessageRequestSchema,
  sendRequestFingerprint,
  type AttachmentTokenRef,
  type InternalSendMailRequest,
  type MessageSummary,
  type SendAttachmentItem,
} from '@hpc-mail/shared';
import type { Context } from 'hono';
import { AppError } from '../lib/errors.js';
import { ok, parseBody } from '../lib/http.js';
import { assertKeyCanUseAddress, assertKeyCanUseSender } from '../middleware/api-key-auth.js';
import { beginIdempotentSend, failIdempotentSend, type IdempotencyActor } from '../services/idempotency.js';
import {
  decodeInlineAttachments,
  deliveryFailedError,
  releaseDeliveryLeases,
  sendMail,
  type DecodedAttachment,
  type Sender,
  type SendMailInput,
} from '../services/outbound.js';
import { composeForward, composeReply, fromRequiredError } from '../services/reply-forward.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import { fetchUrlAttachments, releaseUrlAttachments, type FetchedUrlAttachment } from '../services/url-attachment.js';
import { emitSendResult } from '../services/webhooks.js';
import type { AppContext, Env, ExecCtx } from '../types.js';

/** 发一封信所需的请求环境（与 Hono Context 无关：单发、批量的每一项共用） */
export interface SendEnvironment {
  env: Env;
  ctx: ExecCtx;
  /** 请求 origin：附件下载链接的回退值（优先 env.site_origin） */
  origin: string;
  /** 本站自身的主机名：URL 附件不能指向它们 */
  selfHosts: string[];
}

export function sendEnvironment(c: Context<AppContext>): SendEnvironment {
  return { env: c.env, ctx: c.executionCtx, origin: new URL(c.req.url).origin, selfHosts: selfHostsOf(c) };
}

/** 本站自身的主机名：请求主机与 env.site_origin 的主机 */
export function selfHostsOf(c: Context<AppContext>): string[] {
  const hosts = [new URL(c.req.url).hostname];
  if (c.env.site_origin) {
    try { hosts.push(new URL(c.env.site_origin).hostname); } catch { /* 配置错误时只拦请求主机 */ }
  }
  return hosts;
}

/** 首次响应与同 Key 重放共用：全部收件人被明确拒收为 422，其余（含部分失败、结果未确认的 unknown）照常返回 */
export function settledResult(summary: MessageSummary): MessageSummary {
  if (summary.status === 'failed') {
    throw deliveryFailedError(summary.id, summary.recipientOutcomes ?? [], summary.errorDetail || '全部收件人投递失败');
  }
  return summary;
}

/** 解析前拦下超大请求体：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容 */
export function assertRequestSize(c: Context<AppContext>): void {
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
}

/** 占用幂等键之后才准备的发信内容：回复/转发要读来源邮件，重放时不再读取 */
interface SendPlan {
  req: SendMailInput;
  /** items：attachments[]（base64 或 URL，按原顺序）；tokens：上传附件 */
  attachments: { items: SendAttachmentItem[]; tokens: AttachmentTokenRef[] };
  /** 发件身份是缺省推出的：发信鉴权拒绝时改报 from_required */
  defaultFromAddress?: string;
}

/** 三种附件来源合并：attachments[]（base64 与 URL 按原顺序）在前，上传 token 在后；URL 附件拉取后记进 fetched */
async function prepareAttachments(
  se: SendEnvironment,
  sender: Sender,
  plan: SendPlan,
  leaseToken: string,
  fetched: FetchedUrlAttachment[],
): Promise<DecodedAttachment[]> {
  const { items, tokens } = plan.attachments;
  const decoded = decodeInlineAttachments(items.filter((item) => !isUrlAttachment(item)));
  const stored = await resolveDraftAttachments(se.env, sender.userId, tokens, leaseToken);
  const used = [...decoded, ...stored].reduce((sum, att) => sum + ('bytes' in att ? att.bytes.byteLength : att.size), 0);
  fetched.push(...await fetchUrlAttachments(se.env, sender.userId, items.filter(isUrlAttachment), {
    selfHosts: se.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - used,
  }));
  let inline = 0;
  let remote = 0;
  const ordered = items.map((item): DecodedAttachment => (isUrlAttachment(item) ? fetched[remote++]! : decoded[inline++]!));
  return [...ordered, ...stored];
}

/**
 * 发信的公共流程：占幂等键 → 准备请求与附件（base64、上传 token、URL 拉取）→ sendMail → Webhook 与回收附件。
 * 重放直接返回首次结果；投递开始前的任何失败都按错误类型删除或标记幂等记录并释放租约。
 * 全部收件人失败时首次与重放都抛 422。与 Hono Context 无关：单发与批量的每一项共用。
 */
async function sendWithPlan(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  idempotencyKey: string | undefined,
  fingerprint: unknown,
  prepare: () => Promise<SendPlan>,
): Promise<MessageSummary> {
  const idem = await beginIdempotentSend(se.env, actor, idempotencyKey, fingerprint);
  if (idem.kind === 'replay') return settledResult(idem.response);
  // 本次发送引用的草稿与原附件都登记在这个租约下，投递结束时释放
  const leaseToken = crypto.randomUUID();
  // 拉取转存的 URL 附件不归调用方持有：无论结果如何都在本次请求里回收（已发出的邮件按附件行引用保留对象）
  const fetched: FetchedUrlAttachment[] = [];
  let summary: MessageSummary;
  let tokens: string[] = [];
  try {
    const plan = await prepare();
    tokens = plan.attachments.tokens.map((ref) => ref.token);
    const attachments = await prepareAttachments(se, sender, plan, leaseToken, fetched);
    try {
      summary = await sendMail(se.env, se.ctx, sender, plan.req, attachments, se.origin, idem.handle, leaseToken);
    } catch (error) {
      // 发信鉴权里只有发件身份会报 forbidden
      if (plan.defaultFromAddress && error instanceof AppError && error.code === 'forbidden') throw fromRequiredError(plan.defaultFromAddress);
      throw error;
    }
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
  // Webhook v2 的 mail.sent / mail.failed：放进 waitUntil，按发件行最终状态发，去重键保证同一封只发一次
  await emitSendResult(se.env, sender.userId, summary.id, se.ctx);
  // 全部失败不回收上传附件：同一 token 修正后可以再发。其余结果下邮件可能已发出，回收失败不能翻转请求结果
  // （前端会提示重发，token 又还在，收件人就收到两封），留给 24h 的草稿清理兜底
  const consumed = [...(summary.status !== 'failed' ? tokens : []), ...fetched.map((att) => att.token)];
  if (consumed.length) {
    await consumeDraftAttachments(se.env, sender.userId, consumed)
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error));
  }
  return settledResult(summary);
}

async function runSend(
  c: Context<AppContext>,
  actor: IdempotencyActor,
  sender: Sender,
  fingerprint: unknown,
  prepare: () => Promise<SendPlan>,
): Promise<Response> {
  const summary = await sendWithPlan(sendEnvironment(c), actor, sender, c.req.header('Idempotency-Key'), fingerprint, prepare);
  return ok(c, summary, 201);
}

/** 发一封已解析的发信请求（批量发送的每一项）；结果与 POST /messages 相同，失败抛 AppError */
export function sendOne(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  req: InternalSendMailRequest,
  idempotencyKey: string | undefined,
): Promise<MessageSummary> {
  return sendWithPlan(se, actor, sender, idempotencyKey, sendRequestFingerprint(req), async () => ({
    req, attachments: { items: req.attachments, tokens: req.attachmentTokens },
  }));
}

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
  assertRequestSize(c);
  const req = await parseBody(c, internalSendMailSchema);
  await authorize?.(req);
  return runSend(c, actor, sender, sendRequestFingerprint(req), async () => ({
    req, attachments: { items: req.attachments, tokens: req.attachmentTokens },
  }));
}

/**
 * POST /v1/messages/:id/reply 与 /forward：先占幂等键，再读来源邮件生成收件人、主题、引用与线程头；
 * 同 Key 重放直接返回首次结果，来源邮件之后被删也不影响。
 */
export async function handleCompose(
  c: Context<AppContext>,
  actor: IdempotencyActor,
  sender: Sender,
  op: 'reply' | 'forward',
  sourceId: number,
): Promise<Response> {
  assertRequestSize(c);
  if (op === 'reply') {
    const req = await parseBody(c, replyMessageRequestSchema);
    return runSend(c, actor, sender, composeRequestFingerprint(op, sourceId, req), async () => {
      const composed = await composeReply(c.env, sender, sourceId, req);
      // 限定了范围的 API Key：原信与发件地址都要在范围内（网页会话不受限）
      await assertKeyCanUseAddress(c, composed.sourceAddress);
      await assertKeyCanUseSender(c, composed.req.from);
      return {
        req: composed.req,
        attachments: { items: req.attachments, tokens: req.attachmentTokens },
        ...(composed.fromIsDefault ? { defaultFromAddress: composed.sourceAddress } : {}),
      };
    });
  }
  const req = await parseBody(c, forwardMessageRequestSchema);
  return runSend(c, actor, sender, composeRequestFingerprint(op, sourceId, req), async () => {
    const composed = await composeForward(c.env, sender, sourceId, req);
    await assertKeyCanUseAddress(c, composed.sourceAddress);
    await assertKeyCanUseSender(c, composed.req.from);
    return {
      req: composed.req,
      attachments: { items: [], tokens: [] },
      ...(composed.fromIsDefault ? { defaultFromAddress: composed.sourceAddress } : {}),
    };
  });
}
