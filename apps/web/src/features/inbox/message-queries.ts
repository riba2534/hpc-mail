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

/** 邮件详情查询：详情页、行悬停预取与启动预取共用。GET 无副作用，已读走单独的 POST。 */
export function messageDetailQueryOptions(id: number, view?: MailView) {
  return queryOptions({
    queryKey: queryKeys.messages.detail(id, view),
    queryFn: ({ signal }) => messageApi.detail(id, view, signal),
  });
}
