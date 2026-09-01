import type { WebhookConfig } from '@hpc-mail/shared';
import { hmacSha256Base64 } from '../lib/crypto.js';

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.home.arpa',
  '.nip.io',
  '.sslip.io',
  '.localtest.me',
  '.lvh.me',
  '.vcap.me',
];

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every((value) => value >= 0 && value <= 255) ? values : null;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function parseIpv6(host: string): number[] | null {
  const input = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!input.includes(':')) return null;
  const pieces = input.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const parse = (part: string) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN);
  const leftValues = left.map(parse);
  const rightValues = right.map(parse);
  if ([...leftValues, ...rightValues].some(Number.isNaN)) return null;
  if (pieces.length === 1) return leftValues.length === 8 ? leftValues : null;
  const zeros = 8 - leftValues.length - rightValues.length;
  if (zeros < 1) return null;
  return [...leftValues, ...Array.from({ length: zeros }, () => 0), ...rightValues];
}

function isBlockedIpv6(parts: number[]): boolean {
  const first = parts[0]!;
  if (parts.every((part) => part === 0)) return true;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return true;
  }
  if (first === 0x2001 && parts[1] === 0x0db8) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    const ipv4 = [parts[6]! >> 8, parts[6]! & 0xff, parts[7]! >> 8, parts[7]! & 0xff];
    return isBlockedIpv4(ipv4);
  }
  return false;
}

function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host === 'metadata.google.internal') return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  return ipv6 ? isBlockedIpv6(ipv6) : false;
}

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

export interface WebhookMailPayload {
  event: 'mail.received';
  message: {
    id: number;
    address: string;
    fromAddress: string;
    fromName: string;
    subject: string;
    verificationCode: string;
    preview: string;
    createdAt: string;
  };
}

/** 新邮件通用 webhook 推送（HMAC-SHA256 签名于 X-HPC-Signature，10s 超时，静默失败）。cfg 由调用方按 owner 提供 */
export async function sendNotifyWebhook(
  cfg: WebhookConfig,
  payload: WebhookMailPayload,
): Promise<void> {
  if (!cfg.enabled || !cfg.url) return;
  const url = validateNotifyWebhookUrl(cfg.url);
  if (!url) return;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.secret) {
    headers['X-HPC-Signature'] = await hmacSha256Base64(new TextEncoder().encode(cfg.secret), body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (e) {
    console.error('通用 webhook 推送失败:', e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timeout);
  }
}
