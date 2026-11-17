import type { WebhookConfig } from '@hpc-mail/shared';
import { hmacSha256Base64 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { isBlockedHost } from '../lib/ssrf.js';
import { notificationRequest } from './notification-http.js';

/** 校验通用 webhook URL：必须 https 且非内网 host */
export function validateNotifyWebhookUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (isBlockedHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Svix 签名密钥的原始字节：whsec_ 后面是 base64；不是这种格式的（旧版通用 Webhook 的自定义 secret）按 UTF-8 */
export function signingKeyBytes(secret: string): Uint8Array {
  if (secret.startsWith('whsec_')) {
    try {
      return Uint8Array.from(atob(secret.slice('whsec_'.length)), (ch) => ch.charCodeAt(0));
    } catch {
      // 不是合法 base64 时按普通字符串
    }
  }
  return new TextEncoder().encode(secret);
}

/** Svix 兼容的签名头：webhook-signature = v1,base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")) */
export async function svixHeaders(secret: string, id: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  const signature = await hmacSha256Base64(signingKeyBytes(secret), `${id}.${timestamp}.${body}`);
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
}

export interface WebhookMailPayload {
  event: 'mail.received';
  message: {
    id: number;
    address: string;
    fromAddress: string;
    fromName: string;
    subject: string;
    verificationCode: string;
    /** 识别出的验证/登录链接；没有为空串。升级前入队的任务载荷可能缺失，投递时补空串 */
    verificationLink?: string;
    preview: string;
    createdAt: string;
  };
}

/**
 * 新邮件通用 webhook 推送（10s 超时，静默失败）。配置了 secret 时同时带旧的 X-HPC-Signature（过渡期保留）
 * 与 Svix 兼容签名头；cfg 由调用方按 owner 提供。
 */
export async function sendNotifyWebhook(
  cfg: WebhookConfig,
  payload: WebhookMailPayload,
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  if (!cfg.enabled || !cfg.url) return;
  const url = validateNotifyWebhookUrl(cfg.url);
  if (!url) {
    if (options.throwOnError) throw new AppError('validation_failed', '通用 Webhook 地址非法');
    console.error('通用 Webhook 地址非法');
    return;
  }
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.secret) {
    // 过渡期两种签名都带：旧的 X-HPC-Signature 与 Svix 兼容的 webhook-id/timestamp/signature（同一邮件 id 固定）
    headers['X-HPC-Signature'] = await hmacSha256Base64(new TextEncoder().encode(cfg.secret), body);
    Object.assign(headers, await svixHeaders(cfg.secret, `msg_${payload.message.id}`, body));
  }
  try {
    await notificationRequest(url.toString(), {
      method: 'POST',
      headers,
      body,
    }, '通用 Webhook');
  } catch (e) {
    console.error('通用 webhook 推送失败:', e instanceof Error ? e.message : e);
    if (options.throwOnError) throw e;
  }
}
