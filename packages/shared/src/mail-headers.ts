/**
 * 发信自定义头（headers 字段）的校验，规则对齐 Cloudflare Email Service 的头部白名单
 * （https://developers.cloudflare.com/email-service/reference/headers/）。本站先校验，
 * 平台拒收前就能给出明确错误；前后端共用。
 */

/** 单个头的值上限（UTF-8 字节） */
export const MAX_CUSTOM_HEADER_VALUE_BYTES = 2048;
/** 头名称长度上限 */
export const MAX_CUSTOM_HEADER_NAME_LENGTH = 100;
/** 非 X- 头的个数上限（X- 头不限个数，只受总量约束） */
export const MAX_CUSTOM_NON_X_HEADERS = 20;
/** 全部自定义头的总量上限：Σ(名称 + 2 + 值 + 2) 字节 */
export const MAX_CUSTOM_HEADERS_TOTAL_BYTES = 16 * 1024;

/** 允许的非 X- 头（规范写法）。值为 true 的是结构化头，只接受可打印 ASCII */
const ALLOWED: Record<string, boolean> = {
  'In-Reply-To': true,
  References: true,
  'Thread-Index': true,
  'Thread-Topic': false,
  'List-Unsubscribe': true,
  'List-Unsubscribe-Post': true,
  'List-Id': true,
  'List-Archive': true,
  'List-Help': true,
  'List-Owner': true,
  'List-Post': true,
  'List-Subscribe': true,
  Precedence: true,
  'Auto-Submitted': true,
  'Content-Language': true,
  Keywords: false,
  Comments: false,
  Importance: true,
  Priority: true,
  Sensitivity: true,
  Organization: false,
  'Require-Recipient-Valid-Since': true,
  Expires: true,
  'Reply-By': true,
  'Archived-At': true,
  'OTP-Token': true,
};
export const ALLOWED_CUSTOM_HEADERS = Object.keys(ALLOWED);
const ALLOWED_BY_LOWER = new Map(ALLOWED_CUSTOM_HEADERS.map((name) => [name.toLowerCase(), name]));

/** 平台生成的头：任何情况下都不能自定义 */
export const PLATFORM_HEADERS = [
  'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'DKIM-Signature',
  'Return-Path', 'Received', 'Feedback-ID', 'TLS-Required', 'TLS-Report-Domain', 'TLS-Report-Submitter',
  'CFBL-Address', 'CFBL-Feedback-ID',
];
/** 需用请求里专用字段表达的头 */
export const API_FIELD_HEADERS: Record<string, string> = {
  from: 'from', to: 'to', cc: 'cc', bcc: 'bcc', subject: 'subject', 'reply-to': 'replyTo',
};

const ENUM_VALUES: Record<string, string[]> = {
  Precedence: ['bulk', 'list', 'junk'],
  Importance: ['high', 'normal', 'low'],
  Priority: ['normal', 'non-urgent', 'urgent'],
  Sensitivity: ['personal', 'private', 'company-confidential'],
};

const X_HEADER = /^X-[A-Za-z0-9_-]+$/i;
const ALLOWED_NAME = /^[A-Za-z0-9-]+$/;
const MSG_ID = '<[^<>\\s]+>';
const UNSUBSCRIBE_URI = '<(?:https://[^<>\\s]+|mailto:[^<>\\s]+)>';
const VALUE_PATTERNS: Record<string, { pattern: RegExp; message: string }> = {
  'In-Reply-To': { pattern: new RegExp(`^${MSG_ID}$`), message: '需为单个 <message-id>' },
  References: { pattern: new RegExp(`^${MSG_ID}(?:\\s+${MSG_ID})*$`), message: '需为空格分隔的 <message-id> 列表' },
  'List-Unsubscribe': {
    pattern: new RegExp(`^${UNSUBSCRIBE_URI}(?:\\s*,\\s*${UNSUBSCRIBE_URI})*$`, 'i'),
    message: '需为尖括号包裹的 https 或 mailto URI，多个用逗号分隔（不接受 http）',
  },
};

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export type CustomHeaderCheck =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; code: 'header_not_allowed' | 'validation_failed'; message: string; headers: string[] };

/**
 * 校验并规范化自定义头。成功时返回规范名称（白名单头按规范大小写，X- 头前缀统一为 `X-`）到原值的映射。
 * 名称不允许（平台生成、需用专用字段、不在白名单）一次列出全部，错误码 header_not_allowed；
 * 取值、个数与总量问题报第一个，错误码 validation_failed。两者都在 headers 里给出相关头名称。
 */
export function checkCustomHeaders(input: Record<string, string>): CustomHeaderCheck {
  const entries = Object.entries(input);
  const rejected: string[] = [];
  const reasons: string[] = [];
  const normalized: [string, string, string][] = [];
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (name.length < 1 || name.length > MAX_CUSTOM_HEADER_NAME_LENGTH || !/^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
      rejected.push(name);
      reasons.push(`${name}：名称需为 1–${MAX_CUSTOM_HEADER_NAME_LENGTH} 位 ASCII，不能含空格或冒号`);
    } else if (X_HEADER.test(name)) {
      normalized.push([`X-${name.slice(2)}`, value, name]);
    } else if (Object.hasOwn(API_FIELD_HEADERS, lower)) {
      rejected.push(name);
      reasons.push(`${name}：请改用请求字段 ${API_FIELD_HEADERS[lower]}`);
    } else if (PLATFORM_HEADERS.some((header) => header.toLowerCase() === lower) || lower.startsWith('arc-')) {
      rejected.push(name);
      reasons.push(`${name}：由发信平台生成，不能自定义`);
    } else if (ALLOWED_BY_LOWER.has(lower) && ALLOWED_NAME.test(name)) {
      normalized.push([ALLOWED_BY_LOWER.get(lower)!, value, name]);
    } else {
      rejected.push(name);
      reasons.push(`${name}：不在允许范围（只允许 X- 头与白名单头）`);
    }
  }
  if (rejected.length) {
    return { ok: false, code: 'header_not_allowed', message: `不允许的邮件头：${reasons.join('；')}`, headers: rejected };
  }

  const fail = (header: string, message: string): CustomHeaderCheck =>
    ({ ok: false, code: 'validation_failed', message: `邮件头 ${header}：${message}`, headers: [header] });
  const seen = new Map<string, string>();
  let nonX = 0;
  let total = 0;
  for (const [canonical, value, original] of normalized) {
    const key = canonical.toLowerCase();
    if (seen.has(key)) return fail(original, `与 ${seen.get(key)} 重复（同名头只能出现一次，多个值用逗号合并）`);
    seen.set(key, original);
    if (typeof value !== 'string' || value.trim() === '') return fail(original, '值不能为空');
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) return fail(original, '值不能包含换行或控制字符');
    if (utf8Bytes(value) > MAX_CUSTOM_HEADER_VALUE_BYTES) return fail(original, `值超过 ${MAX_CUSTOM_HEADER_VALUE_BYTES} 字节`);
    // 查表只认自有属性：canonical 只会是白名单名或 X- 头，这里再防一层原型链上的同名属性
    if (Object.hasOwn(ALLOWED, canonical) && ALLOWED[canonical] && /[^\x20-\x7e\t]/.test(value)) return fail(original, '该头只接受可打印 ASCII');
    const allowedValues = Object.hasOwn(ENUM_VALUES, canonical) ? ENUM_VALUES[canonical] : undefined;
    if (allowedValues && !allowedValues.includes(value.trim().toLowerCase())) {
      return fail(original, `只能为 ${allowedValues.join(' / ')}`);
    }
    const rule = Object.hasOwn(VALUE_PATTERNS, canonical) ? VALUE_PATTERNS[canonical] : undefined;
    if (rule && !rule.pattern.test(value.trim())) return fail(original, rule.message);
    if (canonical === 'List-Unsubscribe-Post' && value.trim() !== 'List-Unsubscribe=One-Click') {
      return fail(original, '只能为 List-Unsubscribe=One-Click（区分大小写）');
    }
    if (!canonical.startsWith('X-')) nonX++;
    total += utf8Bytes(canonical) + 2 + utf8Bytes(value) + 2;
  }
  if (nonX > MAX_CUSTOM_NON_X_HEADERS) {
    return { ok: false, code: 'validation_failed', message: `非 X- 头最多 ${MAX_CUSTOM_NON_X_HEADERS} 个`, headers: normalized.filter(([name]) => !name.startsWith('X-')).map(([, , original]) => original) };
  }
  if (total > MAX_CUSTOM_HEADERS_TOTAL_BYTES) {
    return { ok: false, code: 'validation_failed', message: `自定义头合计超过 ${MAX_CUSTOM_HEADERS_TOTAL_BYTES} 字节`, headers: normalized.map(([, , original]) => original) };
  }
  const post = normalized.find(([name]) => name === 'List-Unsubscribe-Post');
  if (post) {
    const unsubscribe = normalized.find(([name]) => name === 'List-Unsubscribe');
    if (!unsubscribe || !/<https:\/\//i.test(unsubscribe[1])) {
      return fail(post[2], '需要同时提供包含 https URI 的 List-Unsubscribe');
    }
  }
  return { ok: true, headers: Object.fromEntries(normalized.map(([name, value]) => [name, value.trim()])) };
}
