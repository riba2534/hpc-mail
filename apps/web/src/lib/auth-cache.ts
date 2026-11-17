import type { QueryClient } from '@tanstack/react-query';
import { getAuthToken, subscribeAuthToken, tokenIdentity } from './auth-token';

const identities = new WeakMap<QueryClient, string | null>();

/**
 * Clear synchronously before React renders the replacement account, including in-flight queries.
 * 按 token 所属账户（JWT sub）判断：同一账户换发 token（改密）不清缓存；换账户、登出才清。
 */
export function subscribeAuthCache(client: QueryClient, listener: () => void): () => void {
  const initialIdentity = tokenIdentity(getAuthToken());
  if (identities.has(client) && identities.get(client) !== initialIdentity) client.clear();
  identities.set(client, initialIdentity);
  return subscribeAuthToken(() => {
    const identity = tokenIdentity(getAuthToken());
    if (identities.get(client) !== identity) {
      identities.set(client, identity);
      client.clear();
    }
    listener();
  });
}
