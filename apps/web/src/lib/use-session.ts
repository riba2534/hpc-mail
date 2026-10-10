import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { SessionUser } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { getAuthRevision, getAuthToken } from './auth-token';
import { subscribeAuthCache } from './auth-cache';

/** 订阅 localStorage token 变化（登录/登出/跨标签页同步） */
export function useAuthToken(): string | null {
  const client = useQueryClient();
  const subscribe = useCallback((listener: () => void) => subscribeAuthCache(client, listener), [client]);
  return useSyncExternalStore(subscribe, getAuthToken, () => null);
}

/** 当前用户查询；启动预取与 AuthGuard 共用，按 token 代次隔离缓存 */
export function sessionQueryOptions(revision: number) {
  return queryOptions({
    queryKey: queryKeys.sessionForRevision(revision),
    queryFn: () => authApi.me(),
    staleTime: 60_000,
    retry: false,
  });
}

/** ['session'] 查询：有 token 时拉取当前用户 */
export function useSessionQuery() {
  const token = useAuthToken();
  return useQuery({ ...sessionQueryOptions(getAuthRevision()), enabled: Boolean(token) });
}

/** 已认证外壳内向下传递已解析的当前用户，避免重复请求 */
export const CurrentUserContext = createContext<SessionUser | null>(null);

export function useCurrentUser(): SessionUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser 必须在已认证的应用外壳内使用');
  return user;
}
