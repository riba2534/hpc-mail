import type { QueryClient } from '@tanstack/react-query';
import { getAuthToken, subscribeAuthToken } from './auth-token';
import { readTokenClaims } from './token-claims';

const identities = new WeakMap<QueryClient, number | string | null>();

/** token 所属账户：同一账户换发的 token（如改密）是同一身份；读不出 sub 时就是 token 本身 */
const identityOf = (token: string | null) => token && (readTokenClaims(token)?.sub ?? token);

/**
 * Clear synchronously before React renders the replacement account, including in-flight queries.
 * 按账户（JWT sub）判断：同一账户换发 token 不清缓存，换账户与登出才清。
 */
export function subscribeAuthCache(client: QueryClient, listener: () => void): () => void {
  const initialIdentity = identityOf(getAuthToken());
  if (identities.has(client) && identities.get(client) !== initialIdentity) client.clear();
  identities.set(client, initialIdentity);
  return subscribeAuthToken(() => {
    const identity = identityOf(getAuthToken());
    if (identities.get(client) !== identity) {
      identities.set(client, identity);
      client.clear();
    }
    listener();
  });
}
