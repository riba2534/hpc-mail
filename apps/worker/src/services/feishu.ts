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
  const subject = cleanText(info.subject, 200) || '(无主题)';
  const senderAddress = cleanText(info.fromAddress, 254) || '未知';
  const senderName = cleanText(info.fromName, 100);
  const recipient = cleanText(info.toAddress, 254) || '未知';
  const code = cleanText(info.code, 64);
  // summary 只推短摘要，full 推完整正文原文，code_only 不推正文
  const bodyLimit = level === 'summary' ? 200 : BODY_LIMIT;
  const body = cleanBody(info.body, bodyLimit) || '（无纯文本正文）';

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `发件人：${senderName ? `${senderName} <${senderAddress}>` : senderAddress}`,
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
    throw new NotificationDeliveryError(
      `飞书 API 错误 ${code ?? '未知'}`,
      response.status,
    );
  }
}

/** 带重试的投递：飞书 webhook 有限频（100/分），瞬时失败重试 2 次（指数退避） */
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
