import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import type { MailView } from './mail-view';

/** 邮件列表查询的唯一定义：useMessagesQuery 与启动预取共用 queryKey/queryFn，预取结果才能被直接命中。 */
export function messageListQueryOptions(query: Partial<ListMessagesQuery>) {
  return infiniteQueryOptions({
    queryKey: queryKeys.messages.list(query),
    queryFn: ({ pageParam, signal }) => messageApi.list({ ...query, cursor: pageParam || undefined }, signal),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * 邮件详情查询：详情页、行悬停预取与启动预取共用。GET 无副作用，已读走单独的 POST。
 * 正文内嵌图的签名 URL 按小时对齐签发、剩余有效期至少 1 小时，新鲜期必须远小于它：回到窗口时刷新过期的详情
 * 换上仍有效的签名；同一小时内重拉的正文完全相同，iframe 不重建。
 */
export function messageDetailQueryOptions(id: number, view?: MailView) {
  return queryOptions({
    queryKey: queryKeys.messages.detail(id, view),
    queryFn: ({ signal }) => messageApi.detail(id, view, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
