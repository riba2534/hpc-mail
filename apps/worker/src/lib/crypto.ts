import { constantTimeEqual } from './password.js';

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    typeof input === 'string' ? encoder.encode(input) : input,
  );
  return bytesToHex(new Uint8Array(digest));
}

/** 十六进制 HMAC-SHA256 */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

/** base64 编码的 HMAC-SHA256（svix/飞书用） */
export async function hmacSha256Base64(secretBytes: Uint8Array, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  let binary = '';
  for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}

const ATTACHMENT_TTL_SECONDS = 5 * 60;

/** 附件签名 URL：HMAC(jwt_secret, `att:{id}.{exp}`)；ttlSeconds 默认 5 分钟（登录用户短期下载），外发转链接传长 TTL */
export async function signAttachment(
  secret: string,
  attId: number,
  ttlSeconds: number = ATTACHMENT_TTL_SECONDS,
): Promise<{ exp: number; sig: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacSha256Hex(secret, `att:${attId}.${exp}`);
  return { exp, sig };
}

export async function verifyAttachmentSig(
  secret: string,
  attId: number,
  exp: number,
  sig: string,
): Promise<boolean> {
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now()) return false;
  const expected = await hmacSha256Hex(secret, `att:${attId}.${exp}`);
  return timingSafeEqualStr(expected, sig);
}
