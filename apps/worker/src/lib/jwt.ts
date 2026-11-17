import { deriveSubkey } from './crypto.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): Uint8Array {
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
}

/** JWT claims：sub=userId, sid=会话 id, epoch=实例代, uepoch=用户代 */
export interface JwtClaims {
  sub: number;
  sid: string;
  epoch: number;
  uepoch: number;
  iat: number;
  exp: number;
}

// 7 天：本系统是「验证码聚合器」，账号价值高，缩短 token 生命周期降低泄露后暴露窗口
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

async function importKey(secret: string, usage: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );
}

export async function signToken(
  secret: string,
  payload: Pick<JwtClaims, 'sub' | 'sid' | 'epoch' | 'uepoch'>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtClaims = { ...payload, iat: now, exp: now + ttlSeconds };
  const headerStr = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadStr = base64url(encoder.encode(JSON.stringify(fullPayload)));
  const data = `${headerStr}.${payloadStr}`;
  // 用 jwt_secret 派生的会话子密钥签名，不与附件链接、中转防环头共用同一把密钥
  const key = await importKey(await deriveSubkey(secret, 'jwt'), ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${base64url(signature)}`;
}

export async function verifyToken(secret: string, token: string): Promise<JwtClaims | null> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return null;
    const data = `${headerB64}.${payloadB64}`;
    const signature = base64urlDecode(signatureB64);
    const verifyWith = async (raw: string) =>
      crypto.subtle.verify('HMAC', await importKey(raw, ['verify']), signature, encoder.encode(data));
    // 过渡期：改用子密钥之前签发的令牌（最长 7 天）仍按 jwt_secret 本身校验，本版本上线 7 天后删除这一分支
    const valid = await verifyWith(await deriveSubkey(secret, 'jwt')) || await verifyWith(secret);
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadB64))) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
