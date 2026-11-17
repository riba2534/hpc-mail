import { type InfiniteData, infiniteQueryOptions, type QueryClient } from '@tanstack/react-query';
import type { ListMailboxesQuery, Mailbox, Page } from '@hpc-mail/shared';
import { api } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/** 全站邮箱每页条数（服务端上限 200） */
export const ADMIN_MAILBOX_PAGE_SIZE = 100;

export type AdminMailboxFilters = Pick<ListMailboxesQuery, 'q' | 'domain'>;

/** 全站邮箱分页只在管理页用到，不放进入口 chunk 里的 api/resources.ts；带 limit 即返回 Page */
function listAdminMailboxes(filters: AdminMailboxFilters, cursor: string, signal?: AbortSignal) {
  return api.get<Page<Mailbox>>('/mailboxes', {
    query: { all: 1, q: filters.q, domain: filters.domain, cursor, limit: ADMIN_MAILBOX_PAGE_SIZE },
    signal,
  });
}

/**
 * 全站邮箱分页（按 id 倒序，服务端搜索）。key 挂在 mailboxes.list('all') 下：
 * 过户、强制释放后 invalidateMailboxOwnership 失效 mailboxes 根，已加载的各页随之重拉。
 */
export const adminMailboxesQueryOptions = (filters: AdminMailboxFilters) =>
  infiniteQueryOptions({
    queryKey: [...queryKeys.mailboxes.list('all'), filters] as const,
    queryFn: ({ pageParam, signal }) => listAdminMailboxes(filters, pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** 在已加载的全站邮箱分页里找一只（进入单个邮箱时先用它渲染，不必等请求） */
export function findLoadedAdminMailbox(client: QueryClient, id: number): Mailbox | undefined {
  const cached = client.getQueriesData<InfiniteData<Page<Mailbox>>>({ queryKey: queryKeys.mailboxes.list('all') });
  for (const [, data] of cached) {
    for (const page of data?.pages ?? []) {
      const found = page.items.find((item) => item.id === id);
      if (found) return found;
    }
  }
  return undefined;
}
