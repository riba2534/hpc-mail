import { base64urlToBytes, bytesToBase64url, constantTimeEqual } from './crypto.js';

export { constantTimeEqual };
const encoder = new TextEncoder();
const PBKDF2_VERSION = 'pbkdf2-sha256';
// Cloudflare Workers 拒绝超过 100000 次迭代的 PBKDF2 请求
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_BYTES = 32;

async function derivePbkdf2(
  password: string,
  salt: string,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64urlToBytes(salt), iterations },
    key,
    PBKDF2_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function generateSalt(length = 16): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return bytesToBase64url(array);
}

/** 版本化格式：pbkdf2-sha256$iterations$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = generateSalt();
  const derived = await derivePbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_VERSION}$${PBKDF2_ITERATIONS}$${salt}$${bytesToBase64url(derived)}`;
}

export async function verifyPassword(inputPassword: string, storedHash: string): Promise<boolean> {
  if (typeof storedHash !== 'string' || !storedHash.startsWith(`${PBKDF2_VERSION}$`)) return false;
  try {
    const [version, iterationValue, encodedSalt, encodedHash] = storedHash.split('$');
    if (version !== PBKDF2_VERSION || !encodedSalt || !encodedHash) return false;
    const iterations = Number(iterationValue);
    if (!Number.isInteger(iterations) || iterations !== PBKDF2_ITERATIONS) return false;
    const actual = await derivePbkdf2(inputPassword, encodedSalt, iterations);
    return constantTimeEqual(actual, base64urlToBytes(encodedHash));
  } catch {
    return false;
  }
}

/** 无偏随机口令（用于种子 admin / 重置） */
export function genRandomPassword(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const unbiasedLimit = Math.floor(256 / chars.length) * chars.length;
  while (result.length < length) {
    const bytes = new Uint8Array(Math.max(16, length - result.length));
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue;
      result += chars[byte % chars.length];
      if (result.length === length) break;
    }
  }
  return result;
}
