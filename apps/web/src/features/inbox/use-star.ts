import { type InfiniteData, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MessageDetail, MessageSummary, Page } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { toast } from '@/components/ui/toast';
import { getAuthToken } from '@/lib/auth-token';
import { ApiError } from '@/api/errors';

type ListData = InfiniteData<Page<MessageSummary>>;

/** 星标切换：乐观更新列表行与详情缓存（即时高亮），失败回滚，最终失效以对齐服务端。 */
export function useStarMutation(view?: { scope?: 'mine' | 'unclaimed' | 'user'; userId?: number }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, starred }: { id: number; starred: boolean }) =>
      messageApi.star([id], starred, view),
    onMutate: async ({ id, starred }) => {
      const token = getAuthToken();
      await queryClient.cancelQueries({ queryKey: queryKeys.messages.root });
      if (token !== getAuthToken()) throw new ApiError('登录账户已变化，请重新操作', { code: 'session_changed' });
      const prevDetail = queryClient.getQueryData<MessageDetail>(queryKeys.messages.detail(id, view));
      queryClient.setQueryData<MessageDetail>(queryKeys.messages.detail(id, view), (prev) =>
        prev ? { ...prev, isStarred: starred } : prev,
      );
      const listSnapshots = queryClient.getQueriesData<ListData>({ queryKey: ['messages', 'list'] });
      for (const [key, data] of listSnapshots) {
        if (!data) continue;
        queryClient.setQueryData<ListData>(key, {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((m) => (m.id === id ? { ...m, isStarred: starred } : m)),
          })),
        });
      }
      return { prevDetail, listSnapshots, token };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.token !== getAuthToken()) return;
      if (ctx?.prevDetail !== undefined) {
        queryClient.setQueryData(queryKeys.messages.detail(id, view), ctx.prevDetail);
      }
      ctx?.listSnapshots?.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast({ title: '操作失败，请重试', variant: 'error' });
    },
    onSuccess: (result, { id }, ctx) => {
      if (ctx?.token !== getAuthToken() || result.changed > 0) return;
      if (ctx.prevDetail !== undefined) queryClient.setQueryData(queryKeys.messages.detail(id, view), ctx.prevDetail);
      ctx.listSnapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
      toast({ title: '星标状态未改变，正在重新加载' });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
    },
  });
}
