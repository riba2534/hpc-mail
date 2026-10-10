import type { QueryClient } from '@tanstack/react-query';
import { inboxListQuery, parseInboxFilters } from '@/features/inbox/inbox-query';
import { parseMailView } from '@/features/inbox/mail-view';
import { messageDetailQueryOptions, messageListQueryOptions } from '@/features/inbox/message-queries';
import { mailboxesQueryOptions, sharedMailboxesQueryOptions } from '@/features/mailboxes/use-mailboxes';
import { getAuthRevision, getAuthToken } from '@/lib/auth-token';
import { queryClient as defaultClient } from '@/lib/query-client';
import { domainsQueryOptions, publicConfigQueryOptions } from '@/lib/use-config';
import { sessionQueryOptions } from '@/lib/use-session';
import { loadAppShell, normalizePathname, routeLoaderFor, warmModule } from './route-modules';

/**
 * 已登录时并行发起外壳 chunk、当前路由 chunk 与首屏数据，拍平
 * 「入口 → /auth/me → 外壳/路由 chunk → 邮箱列表 → 邮件列表」的串行瀑布。
 * 各查询与页面使用同一组 queryOptions，页面挂载时直接命中进行中的请求。
 */
export function prefetchAuthedRoute(client: QueryClient, rawPathname: string, search = ''): void {
  const pathname = normalizePathname(rawPathname);
  warmModule(loadAppShell);
  const loadRoute = routeLoaderFor(pathname);
  if (loadRoute) warmModule(loadRoute);
  const params = new URLSearchParams(search);

  if (pathname === '/' || pathname === '/inbox') {
    void client.prefetchQuery(mailboxesQueryOptions());
    void client.prefetchQuery(sharedMailboxesQueryOptions());
    void client.prefetchQuery(domainsQueryOptions());
    // "/" 会重定向到不带查询串的 /inbox
    const filters = parseInboxFilters(pathname === '/' ? new URLSearchParams() : params);
    void client.prefetchInfiniteQuery(messageListQueryOptions(inboxListQuery(filters)));
    return;
  }

  const mail = /^\/mail\/(\d+)$/.exec(pathname);
  if (mail) void client.prefetchQuery(messageDetailQueryOptions(Number(mail[1]), parseMailView(params)));
}

/** main.tsx 在 createRoot 之前调用：公开配置无条件预取，其余仅在有 token 时进行。 */
export function bootPrefetch(
  client: QueryClient = defaultClient,
  location: Pick<Location, 'pathname' | 'search'> = globalThis.location,
): void {
  void client.prefetchQuery(publicConfigQueryOptions());
  if (!getAuthToken()) return;
  void client.prefetchQuery(sessionQueryOptions(getAuthRevision()));
  prefetchAuthedRoute(client, location.pathname, location.search);
}
