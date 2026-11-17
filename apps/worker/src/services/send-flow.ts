import {
  isUrlAttachment,
  type AttachmentTokenRef,
  type InternalSendMailRequest,
  type MessageSummary,
  type SendAttachmentItem,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env, ExecCtx } from '../types.js';
import { beginIdempotentSend, failIdempotentSend, type IdempotencyActor } from './idempotency.js';
import {
  decodeInlineAttachments,
  deliveryFailedError,
  releaseDeliveryLeases,
  sendMail,
  type DecodedAttachment,
  type LateAttachments,
  type Sender,
  type SendMailInput,
} from './outbound.js';
import { fromRequiredError } from './reply-forward.js';
import { consumeDraftAttachments, resolveDraftAttachments } from './upload.js';
import { fetchUrlAttachments, releaseUrlAttachments, type FetchedUrlAttachment } from './url-attachment.js';
import type { UrlBufferBudget } from './url-fetch-budget.js';
import { emitSendResult } from './webhooks.js';

/** 发一封信所需的请求环境（与 Hono Context 无关：单发、批量的每一项、草稿发送共用） */
export interface SendEnvironment {
  env: Env;
  ctx: ExecCtx;
  /** 请求 origin：附件下载链接的回退值（优先 env.site_origin） */
  origin: string;
  /** 本站自身的主机名：URL 附件不能指向它们 */
  selfHosts: string[];
  /** 本请求「长度未知」URL 附件的内存缓冲预算：整个请求（含批量的各项）共用一份 */
  urlBuffer: UrlBufferBudget;
}

/** 占用幂等键之后才准备的发信内容：回复/转发要读来源邮件，重放时不再读取 */
export interface SendPlan {
  req: SendMailInput;
  /** items：attachments[]（base64 或 URL，按原顺序）；tokens：上传附件 */
  attachments: { items: SendAttachmentItem[]; tokens: AttachmentTokenRef[] };
  /** 发件身份是缺省推出的：发信鉴权拒绝时改报 from_required */
  defaultFromAddress?: string;
  /** 服务端草稿发送：上传附件可以是这份草稿引用的 */
  draftId?: number;
}

/** 已解析的发信请求原样作为发送内容（附件取请求里的两路） */
export function planOf(req: InternalSendMailRequest): SendPlan {
  return { req, attachments: { items: req.attachments, tokens: req.attachmentTokens } };
}

/** 首次响应与同 Key 重放共用：全部收件人被明确拒收为 422，其余（含部分失败、结果未确认的 unknown）照常返回 */
export function settledResult(summary: MessageSummary): MessageSummary {
  if (summary.status === 'failed') {
    throw deliveryFailedError(summary.id, summary.recipientOutcomes ?? [], summary.errorDetail || '全部收件人投递失败');
  }
  return summary;
}

/**
 * 三种附件来源：base64 与上传 token 先备好；URL 附件交给 sendMail 在发件授权与外发配额都通过后再拉取（late），
 * 拉取后按 attachments[] 的原顺序与 base64 合并、token 附件排在后面，拉到的记进 fetched 供回收。
 */
async function prepareAttachments(
  se: SendEnvironment,
  sender: Sender,
  plan: SendPlan,
  leaseToken: string,
  fetched: FetchedUrlAttachment[],
): Promise<{ ready: DecodedAttachment[]; late?: LateAttachments }> {
  const { items, tokens } = plan.attachments;
  const decoded = decodeInlineAttachments(items.filter((item) => !isUrlAttachment(item)));
  const stored = await resolveDraftAttachments(se.env, sender.userId, tokens, leaseToken, { draftId: plan.draftId });
  const urls = items.filter(isUrlAttachment);
  if (!urls.length) return { ready: [...decoded, ...stored] };
  return {
    ready: [...decoded, ...stored],
    late: {
      count: urls.length,
      load: async (budgetBytes) => {
        fetched.push(...await fetchUrlAttachments(se.env, sender.userId, urls, {
          selfHosts: se.selfHosts, budgetBytes, memory: se.urlBuffer,
        }));
        return [...inItemOrder<DecodedAttachment>(items, decoded, fetched), ...stored];
      },
    },
  };
}

/** attachments[] 的 base64 与 URL 两路分开处理后，按请求里的原顺序合并（发信与保存草稿共用） */
export function inItemOrder<T>(items: SendAttachmentItem[], inline: T[], remote: T[]): T[] {
  let i = 0;
  let r = 0;
  return items.map((item) => (isUrlAttachment(item) ? remote[r++]! : inline[i++]!));
}

/**
 * 所有发信入口（/api 与 /v1 发信、回复/转发、批量的每一项、草稿立即与定时发送）的公共流程：
 * 占幂等键 → 准备请求与附件（base64、上传 token、URL 拉取）→ sendMail → Webhook 与回收附件。
 * 重放直接返回首次结果；投递开始前的任何失败都按错误类型删除或标记幂等记录并释放租约，再原样抛出。
 * 全部收件人失败也返回结果（status=failed），由调用方决定报 422 还是记到草稿上。
 */
export async function deliverSend(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  idempotencyKey: string | undefined,
  fingerprint: unknown,
  prepare: () => Promise<SendPlan>,
): Promise<MessageSummary> {
  const idem = await beginIdempotentSend(se.env, actor, idempotencyKey, fingerprint);
  if (idem.kind === 'replay') return idem.response;
  // 本次发送引用的草稿与原附件都登记在这个租约下，投递结束时释放
  const leaseToken = crypto.randomUUID();
  // 拉取转存的 URL 附件不归调用方持有：无论结果如何都在本次请求里回收（已发出的邮件按附件行引用保留对象）
  const fetched: FetchedUrlAttachment[] = [];
  let summary: MessageSummary;
  let tokens: string[] = [];
  try {
    const plan = await prepare();
    tokens = plan.attachments.tokens.map((ref) => ref.token);
    const { ready, late } = await prepareAttachments(se, sender, plan, leaseToken, fetched);
    try {
      summary = await sendMail(se.env, se.ctx, sender, plan.req, ready, se.origin, idem.handle, leaseToken, late);
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
  // 全部失败不回收上传附件：同一 token 修正后可以再发（草稿的附件仍归草稿）。其余结果下邮件可能已发出，回收失败不能翻转
  // 请求结果（前端会提示重发，token 又还在，收件人就收到两封），留给 24h 的草稿清理兜底
  const consumed = [...(summary.status !== 'failed' ? tokens : []), ...fetched.map((att) => att.token)];
  if (consumed.length) {
    await consumeDraftAttachments(se.env, sender.userId, consumed)
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error));
  }
  return summary;
}
