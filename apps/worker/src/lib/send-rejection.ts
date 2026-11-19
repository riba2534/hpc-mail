/**
 * Cloudflare send_email 明确表示没有接受这封信的错误码（官方错误码表）：请求校验、发信域或收件人受限、账户暂停、
 * 内容与头部超限、频率与日配额，以及收件服务器拒收（E_DELIVERY_FAILED）。E_INTERNAL_SERVER_ERROR 与表外的码
 * 不算：服务端可能已经接受。
 */
const REJECTED_SEND_CODES = new Set([
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_ACCOUNT_SUSPENDED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED', 'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
]);

/** 没有错误码的报错（旧版 EmailMessage 路径）按文案识别明确拒收：目标或发信域未验证、地址非法、发信域未开通、超出频率或配额 */
const REJECTED_SEND_MESSAGES = [
  /\bnot (?:a )?verified\b/i,
  /\binvalid (?:e-?mail |sender |recipient |destination |from |to )?address\b/i,
  /\bdomain (?:is )?not (?:available|enabled|onboarded)\b/i,
  /\brecipient (?:is )?(?:not in (?:the )?allowed|suppressed)\b/i,
  /\b(?:rate|daily|sending) limit exceeded\b/i,
  /\bquota (?:exceeded|reached)\b/i,
];

/**
 * send_email 抛错时邮件是否确定没有被接受。只有能确定的拒收才记 failed（可修正后换 Key 重发）；超时、断连、
 * 内部错误等结果不明的一律 unknown，宁可让调用方先核对，也不诱导重复投递。
 */
export function isDefiniteSendRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return REJECTED_SEND_CODES.has(code);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  return REJECTED_SEND_MESSAGES.some((pattern) => pattern.test(message));
}
