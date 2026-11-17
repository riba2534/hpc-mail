import {
  MAX_SEND_REQUEST_BYTES,
  composeRequestFingerprint,
  forwardMessageRequestSchema,
  internalSendMailSchema,
  replyMessageRequestSchema,
  sendRequestFingerprint,
  type InternalSendMailRequest,
  type MessageSummary,
  type SendFrom,
} from '@hpc-mail/shared';
import type { Context } from 'hono';
import { AppError } from '../lib/errors.js';
import { ok, parseBody } from '../lib/http.js';
import { assertKeyCanUseAddress, assertKeyCanUseSender, keyRestriction, requireScope } from '../middleware/api-key-auth.js';
import type { IdempotencyActor } from '../services/idempotency.js';
import { loadSourceMessage } from '../services/message.js';
import type { Sender } from '../services/outbound.js';
import { composeForward, composeReply, type ComposedSend } from '../services/reply-forward.js';
import { deliverSend, planOf, settledResult, type SendEnvironment, type SendPlan } from '../services/send-flow.js';
import type { AppContext } from '../types.js';

export function sendEnvironment(c: Context<AppContext>): SendEnvironment {
  return { env: c.env, ctx: c.executionCtx, origin: new URL(c.req.url).origin, selfHosts: selfHostsOf(c) };
}

/** 本站自身的主机名：请求主机与 env.site_origin 的主机 */
function selfHostsOf(c: Context<AppContext>): string[] {
  const hosts = [new URL(c.req.url).hostname];
  if (c.env.site_origin) {
    try { hosts.push(new URL(c.env.site_origin).hostname); } catch { /* 配置错误时只拦请求主机 */ }
  }
  return hosts;
}

/** 解析前拦下超大请求体：JSON 解析、幂等哈希、base64 解码会同时持有好几份内容 */
export function assertRequestSize(c: Context<AppContext>): void {
  if (Number(c.req.header('Content-Length')) > MAX_SEND_REQUEST_BYTES) {
    throw new AppError('payload_too_large', `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / 1024 / 1024}MB 上限`);
  }
}

/**
 * 发信内容的 Key 授权（网页会话不受限），单发、批量的每一项与草稿共用：引用来源邮件（回复、转发附件）时另需 mail.read；
 * 限定了范围的 Key，发件地址与引用的来源邮件都要在范围内。发件邮箱或来源不存在、不可见时交给发信流程按原有口径报 404，
 * 这里只拦范围外的。
 */
export async function authorizeSendContent(
  c: Context<AppContext>,
  content: { from?: SendFrom | null; replyToMessageId?: number | null; forwardAttachmentsFrom?: number | null },
): Promise<void> {
  const key = c.get('apiKey');
  if (!key) return;
  // 转发附件、回复都会读出来源邮件的内容或邮件头，与下载附件同属读取，不能只凭 mail.send
  if (content.replyToMessageId || content.forwardAttachmentsFrom) requireScope(c, 'mail.read');
  if (!keyRestriction(c)) return;
  if (content.from) await assertKeyCanUseSender(c, content.from);
  const sources = [['reply', content.replyToMessageId], ['forward', content.forwardAttachmentsFrom]] as const;
  for (const [source, id] of sources) {
    if (!id) continue;
    const row = await loadSourceMessage(c.env, { userId: key.userId, role: key.role }, id, '引用的原邮件不存在或不可见', source);
    await assertKeyCanUseAddress(c, row.address);
  }
}

/** 单发与批量：全部收件人失败时首次与重放都抛 422 */
async function sendWithPlan(
  se: SendEnvironment,
  actor: IdempotencyActor,
  sender: Sender,
  idempotencyKey: string | undefined,
  fingerprint: unknown,
  prepare: () => Promise<SendPlan>,
): Promise<MessageSummary> {
  return settledResult(await deliverSend(se, actor, sender, idempotencyKey, fingerprint, prepare));
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
  return sendWithPlan(se, actor, sender, idempotencyKey, sendRequestFingerprint(req), async () => planOf(req));
}

/** /api/messages/send 与 POST /v1/messages 共用的发信处理：解析出请求后、占用幂等键前做 Key 授权 */
export async function handleSend(c: Context<AppContext>, actor: IdempotencyActor, sender: Sender): Promise<Response> {
  assertRequestSize(c);
  const req = await parseBody(c, internalSendMailSchema);
  await authorizeSendContent(c, req);
  return runSend(c, actor, sender, sendRequestFingerprint(req), async () => planOf(req));
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
    return runSend(c, actor, sender, composeRequestFingerprint(op, sourceId, req), async () =>
      composedPlan(c, await composeReply(c.env, sender, sourceId, req), { items: req.attachments, tokens: req.attachmentTokens }));
  }
  const req = await parseBody(c, forwardMessageRequestSchema);
  return runSend(c, actor, sender, composeRequestFingerprint(op, sourceId, req), async () =>
    composedPlan(c, await composeForward(c.env, sender, sourceId, req), { items: [], tokens: [] }));
}

/** 回复/转发算好的请求转成发送内容；限定了范围的 API Key，原信与发件地址都要在范围内（网页会话不受限） */
async function composedPlan(c: Context<AppContext>, composed: ComposedSend, attachments: SendPlan['attachments']): Promise<SendPlan> {
  await assertKeyCanUseAddress(c, composed.sourceAddress);
  await assertKeyCanUseSender(c, composed.req.from);
  return { req: composed.req, attachments, ...(composed.fromIsDefault ? { defaultFromAddress: composed.sourceAddress } : {}) };
}
