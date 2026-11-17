/** 成功：HTTP 2xx + { data }；失败：HTTP 4xx/5xx + { error, requestId } */
export interface ApiSuccess<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
  requestId: string;
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
  internal: 500,
};
