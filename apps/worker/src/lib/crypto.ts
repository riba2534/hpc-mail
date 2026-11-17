import { constantTimeEqual } from './password.js';

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

/** jwt_secret 派生出的各用途子密钥：会话令牌、附件签名链接、转发中转防环头 */
export type SubkeyPurpose = 'jwt' | 'attachment' | 'relay';

const subkeys = new Map<string, Promise<string>>();

/**
 * 子密钥 = HMAC-SHA256(jwt_secret, "hpc-mail/subkey/v1/<用途>") 的十六进制，按 (密钥, 用途) 在 isolate 内缓存。
 * 一把密钥不再直接签多种东西，各用途互不相通；之后要单独轮换某个用途时只需换它的派生来源。
 * 金丝雀令牌按自己的约定直接用 jwt_secret 计算，不经过这里。
 */
export function deriveSubkey(secret: string, purpose: SubkeyPurpose): Promise<string> {
  const id = `${purpose}\n${secret}`;
  let key = subkeys.get(id);
  if (!key) {
    key = hmacSha256Hex(secret, `hpc-mail/subkey/v1/${purpose}`);
    subkeys.set(id, key);
  }
  return key;
}

/** 站内详情签名的时间桶：exp 对齐到整点 */
export const ATTACHMENT_BUCKET_SECONDS = 60 * 60;
/**
 * /v1 详情的签名有效期：调用方另有带 Key 鉴权的附件端点，签名 URL 只是临时直链，
 * 保持 5 分钟，Key 吊销后很快失效。
 */
export const V1_ATTACHMENT_TTL_SECONDS = 5 * 60;

/**
 * 附件签名 URL：HMAC(附件子密钥, `att:{id}.{exp}`)。
 * 不传 ttlSeconds 时供站内详情（附件与 CID 内联图）：exp 取当前小时之后的第二个整点，有效期 1–2 小时，
 * 同一小时内重复请求得到相同的 URL，内嵌图的正文 HTML 不随每次刷新变化。外发转链接传长 TTL。
 */
export async function signAttachment(
  secret: string,
  attId: number,
  ttlSeconds?: number,
): Promise<{ exp: number; sig: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = ttlSeconds === undefined
    ? (Math.floor(now / ATTACHMENT_BUCKET_SECONDS) + 2) * ATTACHMENT_BUCKET_SECONDS
    : now + ttlSeconds;
  const sig = await hmacSha256Hex(await deriveSubkey(secret, 'attachment'), `att:${attId}.${exp}`);
  return { exp, sig };
}

export async function verifyAttachmentSig(
  secret: string,
  attId: number,
  exp: number,
  sig: string,
): Promise<boolean> {
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now()) return false;
  const expected = await hmacSha256Hex(await deriveSubkey(secret, 'attachment'), `att:${attId}.${exp}`);
  if (timingSafeEqualStr(expected, sig)) return true;
  // 过渡期：改用子密钥之前直接用 jwt_secret 签出的链接（外发大附件有效期 90 天）继续有效，
  // 发出的最后一批旧链接过期（本版本上线 90 天）后删除这一分支
  return timingSafeEqualStr(await hmacSha256Hex(secret, `att:${attId}.${exp}`), sig);
}
