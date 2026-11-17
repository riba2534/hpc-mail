export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * 读 JWT payload 的 sub/exp。只用来区分账户、挑选缓存 key（以及跳过明显已过期 token 的恢复），
 * 不验签、不做鉴权判断：会话是否有效始终以 /auth/me 为准。
 */
export function readTokenClaims(token: string | null): { sub: number; exp?: number } | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')));
    if (!isObject(claims) || typeof claims.sub !== 'number' || !Number.isSafeInteger(claims.sub)) return null;
    return { sub: claims.sub, exp: typeof claims.exp === 'number' ? claims.exp : undefined };
  } catch {
    return null;
  }
}
