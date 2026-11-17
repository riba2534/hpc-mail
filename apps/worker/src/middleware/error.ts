import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorBody, ErrorCode } from '@hpc-mail/shared';
import { AppError, type AppErrorHints } from '../lib/errors.js';
import type { AppContext } from '../types.js';

/** 客户端传入的 X-Request-ID 只接受短的安全字符，否则改用服务端生成的 UUID（会写进审计日志） */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** 错误码说明文档；具体原因的锚点见 references/errors.md */
export const ERRORS_DOC = '/references/errors.md';

/**
 * 抛错处没给 fix/docs 时按错误码补的通用建议。只收录有明确改正方式的错误码；
 * forbidden 等原因各异的错误码由抛错处给出具体建议（如缺少 scope、发件身份无权）。
 */
export const DEFAULT_ERROR_HINTS: Partial<Record<ErrorCode, AppErrorHints>> = {
  idempotency_mismatch: {
    fix: '这个 Idempotency-Key 已用于不同内容：换一个新的 Key 再发送',
    docs: `${ERRORS_DOC}#idempotency_mismatch`,
  },
  send_in_progress: {
    fix: '不要换 Key 重发：用 GET /v1/messages?direction=outbound（网页会话用 /api/messages）查看发送结果，稍后用同一个 Key 重试可拿到原结果',
    docs: `${ERRORS_DOC}#send_in_progress`,
  },
  source_unavailable: {
    fix: '原邮件已删除或不可见：去掉 replyToMessageId / forwardAttachmentsFrom 后作为新邮件发送',
    docs: `${ERRORS_DOC}#source_unavailable`,
  },
  header_not_allowed: {
    fix: '只保留 X- 开头的头与白名单头；From/To/Cc/Bcc/Subject/Reply-To 用对应的请求字段',
    docs: `${ERRORS_DOC}#header_not_allowed`,
  },
  delivery_failed: {
    fix: '没有任何收件人收到：按 details.recipientOutcomes 的原因修正后，用新的 Idempotency-Key 重发',
    docs: `${ERRORS_DOC}#delivery_failed`,
  },
  payload_too_large: {
    fix: '大附件先用 POST /v1/uploads（网页会话用 /api/uploads）上传，再在 attachmentTokens 里引用 token',
    docs: `${ERRORS_DOC}#payload_too_large`,
  },
  rate_limited: {
    fix: '稍后重试（/v1 请求见 X-RateLimit-Reset 响应头）；GET /v1/me 可查看 Key 的速率上限与今日外发用量',
    docs: `${ERRORS_DOC}#rate_limited`,
  },
  draft_state_conflict: {
    fix: '先 GET /drafts/:id 读取草稿当前的 status 与 version：发送中的等它结束；已发送的结果看 messageId；版本变了就基于最新内容重新修改',
    docs: `${ERRORS_DOC}#draft_state_conflict`,
  },
  draft_limit_reached: {
    fix: '未发送的草稿已达上限：先发送或删除不需要的草稿（GET /drafts 列出），再创建',
    docs: `${ERRORS_DOC}#draft_limit_reached`,
  },
  attachment_url_forbidden: {
    fix: '只能引用公网可访问的 https 地址；内网或本站的文件先下载，再用 POST /v1/uploads（网页会话用 /api/uploads）上传后写进 attachmentTokens',
    docs: `${ERRORS_DOC}#attachment_url_forbidden`,
  },
  attachment_url_fetch_failed: {
    fix: '确认地址能公开访问（预签名链接未过期、不需要登录），或先下载再用 POST /v1/uploads（网页会话用 /api/uploads）上传后写进 attachmentTokens',
    docs: `${ERRORS_DOC}#attachment_url_fetch_failed`,
  },
};

/** 每请求分配 requestId 并回显 X-Request-ID */
export const requestId: MiddlewareHandler<AppContext> = async (c, next) => {
  const supplied = c.req.header('X-Request-ID');
  const id = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-ID', id);
  const specification = c.req.path.startsWith('/v1/') || c.req.path === '/v1'
    ? '/v1/openapi.json'
    : '/api/openapi.json';
  c.header('Link', `</skill.md>; rel="describedby"; type="text/markdown", <${specification}>; rel="service-desc"; type="application/vnd.oai.openapi+json"`);
  await next();
};

/** 站内路径按请求 origin 补成绝对 URL，自部署实例的链接指向自己 */
function absoluteDocs(c: Context<AppContext>, docs: string): string {
  try { return new URL(docs, c.req.url).toString(); }
  catch { return docs; }
}

/**
 * 错误 → 信封里的 error 对象与 HTTP 状态：AppError 按错误码补默认 fix/docs，其他异常一律 internal。
 * 5xx 记一行结构化日志。统一信封与批量发送的逐项结果共用。
 */
export function errorObject(
  err: unknown,
  c: Context<AppContext>,
  requestId = c.get('requestId'),
): { status: number; error: ApiErrorBody['error'] } {
  const log = (errorClass: string, message: string) => console.error(JSON.stringify({
    level: 'error',
    requestId,
    operation: `${c.req.method} ${c.req.path}`,
    errorClass,
    message,
  }));
  if (err instanceof AppError) {
    if (err.status >= 500) log(err.code, err.message);
    const defaults = DEFAULT_ERROR_HINTS[err.code] ?? {};
    const fix = err.hints.fix ?? defaults.fix;
    const docs = err.hints.docs ?? defaults.docs;
    const details = err.hints.details;
    return {
      status: err.status,
      error: {
        code: err.code,
        message: err.message,
        ...(fix ? { fix } : {}),
        ...(docs ? { docs: absoluteDocs(c, docs) } : {}),
        ...(details ? { details } : {}),
      },
    };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  log(error.name || 'Error', error.message || 'unhandled error');
  return { status: 500, error: { code: 'internal', message: '服务器内部错误' } };
}

/** 统一错误信封：{ error:{code,message,fix?,docs?,details?}, requestId } + 语义化状态码 */
export function onError(err: Error, c: Context<AppContext>): Response {
  const rid = c.get('requestId') ?? crypto.randomUUID();
  const { status, error } = errorObject(err, c, rid);
  const body: ApiErrorBody = { error, requestId: rid };
  return c.json(body, status as ContentfulStatusCode);
}
