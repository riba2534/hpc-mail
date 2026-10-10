import type { FeishuConfig } from '@hpc-mail/shared';
import { hmacSha256Base64 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { NotificationDeliveryError, notificationRequest } from './notification-http.js';

const FEISHU_WEBHOOK_HOSTS = new Set([
  'open.feishu.cn',
  'open.larksuite.com',
  'open.larkoffice.com',
]);
const FEISHU_WEBHOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,200}$/;
// 飞书交互卡片整体有大小上限（约 30KB），正文取原文但仍需截断到安全长度
const BODY_LIMIT = 4000;

/** 白名单校验飞书 webhook URL（防 SSRF），非法抛错 */
export function validateFeishuWebhookUrl(value: string): string {
  if (!value.trim()) throw new AppError('validation_failed', '飞书 webhook 为空');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError('validation_failed', '飞书 webhook 格式非法');
  }
  if (
    url.protocol !== 'https:' ||
    !FEISHU_WEBHOOK_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !FEISHU_WEBHOOK_PATH.test(url.pathname)
  ) {
    throw new AppError('validation_failed', '飞书 webhook 非法');
  }
  return url.toString();
}

/** 飞书签名：HMAC-SHA256(key=`${timestamp}\n${secret}`, data='')，base64 */
export async function generateFeishuSignature(timestamp: string, secret: string): Promise<string> {
  if (!secret) return '';
  const stringToSign = `${timestamp}\n${secret}`;
  return hmacSha256Base64(new TextEncoder().encode(stringToSign), '');
}

function cleanText(value: string | undefined | null, limit: number): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export interface FeishuMailInfo {
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  code: string;
  /** 邮件正文原文（纯文本） */
  body: string;
  /** 站内详情页链接；有值时卡片带「打开邮件」按钮 */
  link?: string;
}

/**
 * 飞书对机器人消息做内容安全审核，含完整邮箱地址会被判为敏感信息（11312）整条拒收。
 * 卡片里所有邮箱一律脱敏：地址字段只保留本地部分前两位与域名，正文里出现的邮箱替换为占位。
 * 需要完整地址时点「打开邮件」到站内查看。
 */
const EMAIL_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;
const EMAIL_PLACEHOLDER = '[邮箱已隐藏]';

export function redactEmails(value: string): string {
  return value.replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);
}

/** 地址字段脱敏：ab***（example.com）；不保留 @，避免仍被识别为邮箱 */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return redactEmails(address);
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length - 1) || 1)}***（${domain}）`;
}

/** 正文清理：保留换行（原文排版），去除危险控制字符；超限截断并标注 */
function cleanBody(value: string | undefined | null, limit: number): string {
  const normalized = String(value || '')
    .replace(/\r\n?/g, '\n')
    // 去控制字符但保留 \t(09) 与 \n(0a)
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || (c >= 32 && c !== 127);
    })
    .join('')
    .trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…（正文过长，已截断）` : normalized;
}

export type FeishuContentLevel = 'code_only' | 'summary' | 'full';

export function buildFeishuEmailCard(
  info: FeishuMailInfo,
  test = false,
  level: FeishuContentLevel = 'full',
): unknown {
  const subject = redactEmails(cleanText(info.subject, 200)) || '(无主题)';
  const fromAddress = cleanText(info.fromAddress, 254);
  const senderAddress = fromAddress ? maskEmailAddress(fromAddress) : '未知';
  const senderName = redactEmails(cleanText(info.fromName, 100));
  const toAddress = cleanText(info.toAddress, 254);
  const recipient = toAddress ? maskEmailAddress(toAddress) : '未知';
  const code = cleanText(info.code, 64);
  // summary 只推短摘要，full 推完整正文原文，code_only 不推正文
  const bodyLimit = level === 'summary' ? 200 : BODY_LIMIT;
  const body = redactEmails(cleanBody(info.body, bodyLimit)) || '（无纯文本正文）';

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `发件人：${senderName ? `${senderName} ${senderAddress}` : senderAddress}`,
      },
    },
    { tag: 'div', text: { tag: 'plain_text', content: `收件邮箱：${recipient}` } },
  ];
  if (code) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**验证码：**<font color='red'>${code}</font>` },
    });
  }
  // code_only：只推元信息与验证码，不含正文，最大化保护隐私
  if (level !== 'code_only') {
    elements.push(
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'plain_text', content: body } },
    );
  }
  if (info.link) {
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '打开邮件' }, type: 'primary', url: info.link },
      ],
    });
  }

  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: test ? 'blue' : 'turquoise',
        title: {
          tag: 'plain_text',
          content: `${test ? '配置测试 · ' : '新邮件 · '}${subject}`,
        },
      },
      elements,
    },
  };
}

/**
 * 明确不可重试的飞书错误码：重发同样的内容只会得到同样的结果。
 * 11312 内容审核拒收；19021 签名/时间戳校验失败；19022 IP 不在白名单；19024 关键词不匹配；
 * 19007 机器人已停用；19001/19002/9499 请求参数非法。
 */
const FEISHU_PERMANENT_ERRORS: Record<number, string> = {
  11312: '消息未通过飞书内容安全审核（含敏感信息）',
  19021: '签名校验失败，请检查机器人签名密钥',
  19022: '请求来源 IP 不在机器人白名单内',
  19024: '消息不含机器人要求的自定义关键词',
  19007: '机器人已被停用',
  19001: '请求参数非法',
  19002: '请求参数非法',
  9499: '请求参数非法',
};

async function postOnce(
  webhookUrl: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body: Record<string, unknown> = { ...payload };
  if (secret) {
    body.timestamp = timestamp;
    body.sign = await generateFeishuSignature(timestamp, secret);
  }
  const response = await notificationRequest(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }, '飞书');
  let parsed: { code?: number; StatusCode?: number; msg?: string };
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new NotificationDeliveryError('飞书返回非法 JSON', response.status);
  }
  const code = parsed && typeof parsed === 'object'
    ? typeof parsed.code === 'number' ? parsed.code : typeof parsed.StatusCode === 'number' ? parsed.StatusCode : null
    : null;
  if (code !== 0) {
    const permanent = code === null ? undefined : FEISHU_PERMANENT_ERRORS[code];
    throw new NotificationDeliveryError(
      permanent ? `飞书 API 错误 ${code}：${permanent}，不会自动重试` : `飞书 API 错误 ${code ?? '未知'}`,
      response.status,
      !permanent,
    );
  }
}

/** 带重试的投递：飞书 webhook 有限频（100/分），瞬时失败重试 2 次（指数退避）；明确不可重试的错误立即返回 */
async function postToFeishu(
  webhookUrl: string,
  secret: string,
  payload: Record<string, unknown>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    }
    try {
      await postOnce(webhookUrl, secret, payload);
      return;
    } catch (e) {
      lastError = e;
      if (e instanceof NotificationDeliveryError && !e.retryable) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 发送收件卡片；throwOnError=false 时静默失败（供 waitUntil 使用）。feishu 配置由调用方按 owner 提供 */
export async function sendFeishuNotification(
  feishu: FeishuConfig,
  info: FeishuMailInfo,
  options: { test?: boolean; force?: boolean; throwOnError?: boolean; attempts?: number } = {},
): Promise<boolean> {
  const { test = false, force = false, throwOnError = false } = options;
  try {
    if (!force && !feishu.enabled) return false;
    if (!feishu.webhookUrl) {
      if (throwOnError) throw new AppError('validation_failed', '飞书 webhook 未配置');
      return false;
    }
    const safeUrl = validateFeishuWebhookUrl(feishu.webhookUrl);
    // 测试卡片强制推全文以便验证；正式通知按管理员设定的内容分级
    const level = test ? 'full' : feishu.contentLevel;
    await postToFeishu(
      safeUrl,
      feishu.secret,
      buildFeishuEmailCard(info, test, level) as Record<string, unknown>,
      Math.max(1, Math.min(3, options.attempts ?? 3)),
    );
    return true;
  } catch (error) {
    console.error('飞书通知失败:', error instanceof Error ? error.message : error);
    if (throwOnError) {
      if (error instanceof AppError) throw error;
      throw new AppError('internal', '飞书 webhook 调用失败');
    }
    return false;
  }
}
