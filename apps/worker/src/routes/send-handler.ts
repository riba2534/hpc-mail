import {
  MAX_SEND_REQUEST_BYTES,
  composeRequestFingerprint,
  forwardMessageRequestSchema,
  internalSendMailSchema,
  replyMessageRequestSchema,
  sendRequestFingerprint,
  type AttachmentTokenRef,
  type InternalSendMailRequest,
  type MessageSummary,
  type SendAttachment,
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
import { decodeInlineAttachments, deliveryFailedError, sendMail, type Sender, type SendMailInput } from '../services/outbound.js';
import { composeForward, composeReply, fromRequiredError } from '../services/reply-forward.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import type { AppContext } from '../types.js';

/** 解析前拦下超大请求体：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容 */
function assertRequestSize(c: Context<AppContext>): void {
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
}

/** 占用幂等键之后才准备的发信内容：回复/转发要读来源邮件，重放时不再读取 */
interface SendPlan {
  req: SendMailInput;
  attachments: { inline: SendAttachment[]; tokens: AttachmentTokenRef[] };
  /** 发件身份是缺省推出的：发信鉴权拒绝时改报 from_required */
  defaultFromAddress?: string;
}

/**
 * 发信的公共流程：占幂等键 → 准备请求与附件 → sendMail → 回填结果与回收草稿。
 * 重放直接返回首次结果；占键之后的任何失败都释放或标记幂等记录。
 */
async function runSend(
  c: Context<AppContext>,
  actor: IdempotencyActor,
  sender: Sender,
  fingerprint: unknown,
  prepare: () => Promise<SendPlan>,
): Promise<Response> {
  const idem = await beginIdempotentSend(c.env, actor, c.req.header('Idempotency-Key'), fingerprint);
  if (idem.kind === 'replay') {
    // 全部收件人失败的结果重放时与首次一样是 422；部分失败、unknown 等仍是 201
    const replay = idem.response;
    if (replay.status === 'failed') {
      throw deliveryFailedError(replay.id, replay.recipientOutcomes ?? [], replay.errorDetail || '全部收件人投递失败');
    }
    return ok(c, replay, 201);
  }
  let summary: MessageSummary;
  let tokens: string[] = [];
  try {
    const plan = await prepare();
    tokens = plan.attachments.tokens.map((ref) => ref.token);
    // 两种附件来源：base64 内联（AI/脚本）+ 上传 token（前端与大文件），合并后送 sendMail
    const attachments = [
      ...decodeInlineAttachments(plan.attachments.inline),
      ...await resolveDraftAttachments(c.env, sender.userId, plan.attachments.tokens),
    ];
    try {
      summary = await sendMail(c.env, c.executionCtx, sender, plan.req, attachments, new URL(c.req.url).origin, idem.handle);
    } catch (error) {
      // 发信鉴权里只有发件身份会报 forbidden
      if (plan.defaultFromAddress && error instanceof AppError && error.code === 'forbidden') throw fromRequiredError(plan.defaultFromAddress);
      throw error;
    }
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
    consumeDraftAttachments(c.env, sender.userId, tokens)
      .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error)),
  ]);
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
  assertRequestSize(c);
  const req = await parseBody(c, internalSendMailSchema);
  authorize?.(req);
  return runSend(c, actor, sender, sendRequestFingerprint(req), async () => ({
    req, attachments: { inline: req.attachments, tokens: req.attachmentTokens },
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
      // TODO(PR4a): assertKeyCanUseAddress(c, composed.sourceAddress) 与解析出的发件地址
      return {
        req: composed.req,
        attachments: { inline: req.attachments, tokens: req.attachmentTokens },
        ...(composed.fromIsDefault ? { defaultFromAddress: composed.sourceAddress } : {}),
      };
    });
  }
  const req = await parseBody(c, forwardMessageRequestSchema);
  return runSend(c, actor, sender, composeRequestFingerprint(op, sourceId, req), async () => {
    const composed = await composeForward(c.env, sender, sourceId, req);
    // TODO(PR4a): assertKeyCanUseAddress(c, composed.sourceAddress) 与解析出的发件地址
    return {
      req: composed.req,
      attachments: { inline: [], tokens: [] },
      ...(composed.fromIsDefault ? { defaultFromAddress: composed.sourceAddress } : {}),
    };
  });
}
