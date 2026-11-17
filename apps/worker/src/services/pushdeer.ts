import type { PushDeerConfig } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { isBlockedHost } from '../lib/ssrf.js';
import { NotificationDeliveryError, notificationRequest } from './notification-http.js';

export const DEFAULT_PUSHDEER_ENDPOINT = 'https://api2.pushdeer.com';

export interface PushDeerMailInfo {
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  code?: string;
  body: string;
}

export function validatePushDeerEndpoint(endpoint?: string): string {
  const raw = (endpoint || '').trim();
  if (!raw) return DEFAULT_PUSHDEER_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('validation_failed', 'PushDeer 接入点格式非法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('validation_failed', 'PushDeer 接入点协议必须为 http 或 https');
  }
  if (isBlockedHost(url.hostname)) {
    throw new AppError('validation_failed', 'PushDeer 接入点不能指向内网地址');
  }
  return url.origin;
}

function cleanText(value: string | undefined | null, limit: number): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function cleanBody(value: string | undefined | null, limit: number): string {
  const normalized = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('')
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || (c >= 32 && c !== 127);
    })
    .join('')
    .trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…（正文过长，已截断）` : normalized;
}

export async function sendPushDeerNotification(
  config: PushDeerConfig,
  info: PushDeerMailInfo,
  opts: { force?: boolean; throwOnError?: boolean } = {},
): Promise<void> {
  if (!opts.force && !config.enabled) return;
  const pushkey = (config.pushkey || '').trim();
  if (!pushkey) {
    if (opts.throwOnError) throw new AppError('validation_failed', '未配置 PushKey');
    return;
  }

  const endpoint = validatePushDeerEndpoint(config.endpoint);
  const url = `${endpoint.replace(/\/$/, '')}/message/push`;

  const code = cleanText(info.code, 64);
  const subject = cleanText(info.subject, 200) || '(无主题)';
  const text = code ? `【验证码: ${code}】${subject}` : subject;

  const senderAddress = cleanText(info.fromAddress, 254) || '未知';
  const senderName = cleanText(info.fromName, 100);
  const sender = senderName ? `${senderName} <${senderAddress}>` : senderAddress;
  const recipient = cleanText(info.toAddress, 254) || '未知';

  const metaLines = [
    `**发件人**: ${sender}`,
    `**收件地址**: ${recipient}`,
  ];
  if (code) {
    metaLines.push(`**验证码**: \`${code}\``);
  }

  const body = cleanBody(info.body, 4000) || '（无纯文本正文）';
  const desp = `${metaLines.join('  \n')}\n\n---\n\n${body}`;

  const payload = {
    pushkey,
    text,
    desp,
    type: 'markdown',
  };

  try {
    const res = await notificationRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 'PushDeer');
    let data: { code?: number } | null;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new NotificationDeliveryError('PushDeer 返回非法 JSON', res.status);
    }
    if (!data || typeof data !== 'object' || data.code !== 0) {
      throw new NotificationDeliveryError(
        `PushDeer API 错误 ${data && typeof data === 'object' && typeof data.code === 'number' ? data.code : '缺少状态码'}`,
        res.status,
        false,
      );
    }
  } catch (error) {
    console.error('PushDeer 推送失败:', error instanceof Error ? error.message : '未知错误');
    if (opts.throwOnError) throw error;
  }
}
