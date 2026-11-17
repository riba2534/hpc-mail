const TOKEN_STORAGE_KEY = 'token';
const TOKEN_EVENT = 'hpc-mail:token-change';
let observedToken: string | null | undefined;
let tokenRevision = 0;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const value = storage()?.getItem(TOKEN_STORAGE_KEY)?.trim();
  const token = value || null;
  if (observedToken !== token) {
    observedToken = token;
    tokenRevision += 1;
  }
  return token;
}

/** A local generation number keeps bearer tokens out of query keys and separates missed storage events. */
export function getAuthRevision(): number { getAuthToken(); return tokenRevision; }

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
    if (typeof claims !== 'object' || claims === null) return null;
    const { sub, exp } = claims as Record<string, unknown>;
    if (typeof sub !== 'number' || !Number.isSafeInteger(sub)) return null;
    return { sub, exp: typeof exp === 'number' ? exp : undefined };
  } catch {
    return null;
  }
}

/** token 所属的账户：同一账户换发的 token（如改密）视为同一身份；读不出 sub 时就是 token 本身 */
export function tokenIdentity(token: string | null): string | null {
  if (!token) return null;
  const claims = readTokenClaims(token);
  return claims ? `uid:${claims.sub}` : token;
}

export function setAuthToken(token: string): void {
  const normalized = token.trim();
  if (!normalized) {
    clearAuthToken();
    return;
  }
  try {
    storage()?.setItem(TOKEN_STORAGE_KEY, normalized);
  } catch {
    // 存储写满或被禁用：保持原状，不让登录、改密的回调抛错中断
    return;
  }
  globalThis.dispatchEvent?.(new CustomEvent(TOKEN_EVENT, { detail: normalized }));
}

export function clearAuthToken(): void {
  storage()?.removeItem(TOKEN_STORAGE_KEY);
  globalThis.dispatchEvent?.(new CustomEvent(TOKEN_EVENT, { detail: null }));
}

export function subscribeAuthToken(listener: () => void): () => void {
  const handleTokenChange = () => listener();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === TOKEN_STORAGE_KEY || event.key === null) listener();
  };
  globalThis.addEventListener?.(TOKEN_EVENT, handleTokenChange);
  globalThis.addEventListener?.('storage', handleStorage);
  return () => {
    globalThis.removeEventListener?.(TOKEN_EVENT, handleTokenChange);
    globalThis.removeEventListener?.('storage', handleStorage);
  };
}

export { TOKEN_STORAGE_KEY };
