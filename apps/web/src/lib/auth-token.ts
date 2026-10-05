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

export function setAuthToken(token: string): void {
  const normalized = token.trim();
  if (!normalized) {
    clearAuthToken();
    return;
  }
  storage()?.setItem(TOKEN_STORAGE_KEY, normalized);
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
