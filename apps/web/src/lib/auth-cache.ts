import type { QueryClient } from '@tanstack/react-query';
import { getAuthToken, subscribeAuthToken } from './auth-token';

const identities = new WeakMap<QueryClient, string | null>();

/** Clear synchronously before React renders the replacement account, including in-flight queries. */
export function subscribeAuthCache(client: QueryClient, listener: () => void): () => void {
  const initialToken = getAuthToken();
  if (identities.has(client) && identities.get(client) !== initialToken) client.clear();
  identities.set(client, initialToken);
  return subscribeAuthToken(() => {
    const token = getAuthToken();
    if (identities.get(client) !== token) {
      identities.set(client, token);
      client.clear();
    }
    listener();
  });
}
