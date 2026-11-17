import type { RecipientOutcome } from './schemas/mail.js';
import type { SuppressedRecipient } from './schemas/delivery-events.js';
import type { SystemDomainPrecheck } from './schemas/system-domain.js';

/** 成功：HTTP 2xx + { data }；失败：HTTP 4xx/5xx + { error, requestId } */
export interface ApiSuccess<T> {
  data: T;
}

/** 错误的结构化补充信息：只出现在对应错误码上，调用方据此修正请求 */
export interface ApiErrorDetails {
  /** header_not_allowed / 头部取值不合法：出问题的头名称（按请求里的写法） */
  headers?: string[];
  /** delivery_failed：已记录的发件行 id（可在已发送里查看）与逐收件人结果 */
  messageId?: number;
  recipientOutcomes?: RecipientOutcome[];
  /** attachment_url_forbidden / attachment_url_fetch_failed：出错的附件地址（重定向后的地址也可能出现在这里） */
  url?: string;
  /** draft_state_conflict：草稿当前状态与版本 */
  draftStatus?: string;
  draftVersion?: number;
  /** source_unavailable：不可用的是哪一个引用（reply = replyToMessageId，forward = forwardAttachmentsFrom 或其附件） */
  source?: 'reply' | 'forward';
  /** recipient_suppressed：命中抑制名单的收件人（全部收件人都在名单里，没有创建发件记录） */
  suppressed?: SuppressedRecipient[];
  /** 系统域名接入 409：最新预检（需确认项、阻断项与指纹），确认后带 fingerprint 与 accept 重试 */
  precheck?: SystemDomainPrecheck;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** 给 Agent 的改正建议（一句话，可直接照做）；没有明确建议时省略 */
    fix?: string;
    /** 相关说明文档的绝对 URL；没有时省略 */
    docs?: string;
    details?: ApiErrorDetails;
  };
  requestId: string;
}

/**
 * zod 自定义 issue 的 params：parseBody/parseQuery 取第一条 issue 时，若带 errorCode 就用它作为错误码，
 * 并把 fix / docs / details 原样放进错误信封（docs 写站内路径，如 /references/errors.md#header_not_allowed）。
 */
export interface IssueErrorParams {
  errorCode?: ErrorCode;
  fix?: string;
  docs?: string;
  details?: ApiErrorDetails;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'bad_credentials',
  'user_disabled',
  'totp_required',
  /** 站点强制两步验证但该账号尚未绑定：403（不是 401——401 会让前端清 token 把人踢出登录态，反而没法去绑定） */
  'totp_setup_required',
  'registration_closed',
  'invite_invalid',
  'address_taken',
  'payload_too_large',
  /** 同一 Idempotency-Key 已用于不同的发信内容：换新 Key 才能发送新内容 */
  'idempotency_mismatch',
  /** 同一 Idempotency-Key 的发送正在处理或结果待确认：先查询原结果，不要换 Key 重发 */
  'send_in_progress',
  /** 回复或转发引用的原邮件不存在、不可见，或其附件已不可用（404）：去掉引用后可作为新邮件发送 */
  'source_unavailable',
  /** 自定义邮件头不在允许范围（平台控制或需用专用字段的头、非白名单头）：400，details.headers 列出被拒的头 */
  'header_not_allowed',
  /** 全部收件人被明确拒收，没有任何一份投递成功：422，details 带发件行 id 与逐收件人结果；同 Key 重放返回同样的错误 */
  'delivery_failed',
  /** 草稿当前状态不允许该操作（发送中不能修改或删除；已发送不能修改），或 expectedVersion 与当前版本不一致：409 */
  'draft_state_conflict',
  /** 未发送的草稿数已达上限：409，先发送或删除旧草稿 */
  'draft_limit_reached',
  /** URL 附件地址不允许：非 https、带账号密码、非 443 端口、内网/回环/链路本地/云元数据地址或本站自身：400 */
  'attachment_url_forbidden',
  /** URL 附件拉取失败：DNS 解析失败、超时、非 2xx、重定向过多或内容为空：422，details.url 为出错的地址 */
  'attachment_url_fetch_failed',
  /** 全部收件人都在本站抑制名单里（此前退信或投诉）：422，没有发信也不占配额，details.suppressed 列出原因与解除时间 */
  'recipient_suppressed',
  /** 回复/转发没给 from，而原信的收件地址不是调用者可用的发件身份（如共享给你的邮箱）：400，在 from 指定自己的地址 */
  'from_required',
  /** 敏感操作（创建 API Key、新增转发目标、开关两步验证）需要在请求里带当前密码 password：403 */
  'reauth_required',
  /** 重新验证时当前密码错误：403（不是 401，网页会话不会因此被清掉）；15 分钟内失败 5 次后 429 */
  'reauth_failed',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 各错误码的默认 HTTP 状态 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  bad_credentials: 401,
  user_disabled: 403,
  totp_required: 401,
  totp_setup_required: 403,
  registration_closed: 403,
  invite_invalid: 400,
  address_taken: 409,
  payload_too_large: 413,
  idempotency_mismatch: 409,
  send_in_progress: 409,
  source_unavailable: 404,
  header_not_allowed: 400,
  delivery_failed: 422,
  draft_state_conflict: 409,
  draft_limit_reached: 409,
  attachment_url_forbidden: 400,
  attachment_url_fetch_failed: 422,
  recipient_suppressed: 422,
  from_required: 400,
  reauth_required: 403,
  reauth_failed: 403,
  internal: 500,
};
