import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const starMock = vi.hoisted(() => vi.fn().mockResolvedValue({changed:1}));
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/resources', () => ({ messageApi: { star: starMock } }));
vi.mock('@/components/ui/toast', () => ({ toast: toastMock }));

import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { useStarMutation } from './use-star';

describe('useStarMutation', () => {
  it('成功后翻转详情缓存的 isStarred 并以 [id] 调用 star', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.messages.detail(7), { id: 7, isStarred: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useStarMutation(), { wrapper });
    result.current.mutate({ id: 7, starred: true });

    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.messages.detail(7))).toMatchObject({ isStarred: true }),
    );
    expect(starMock).toHaveBeenCalledWith([7], true, undefined);
  });

  it('失败时回滚并提示服务端原因与请求 ID', async () => {
    starMock.mockRejectedValueOnce(new ApiError('操作过于频繁', { code: 'rate_limited', httpStatus: 429, requestId: 'req-3' }));
    // 失败提示来自应用的全局 mutationCache
    const { queryClient } = await import('@/lib/query-client');
    queryClient.setQueryData(queryKeys.messages.detail(5), { id: 5, isStarred: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useStarMutation(), { wrapper });
    result.current.mutate({ id: 5, starred: true });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(queryKeys.messages.detail(5))).toMatchObject({ isStarred: false });
    expect(toastMock).toHaveBeenCalledOnce();
    expect(toastMock).toHaveBeenCalledWith({ title: '星标操作失败', description: '操作过于频繁', requestId: 'req-3', variant: 'error' });
    queryClient.clear();
  });

  it('乐观更新改写了首页条目时去掉首页 head，下一轮 sync 按有变化对齐', async () => {
    const queryClient = new QueryClient();
    const listKey = queryKeys.messages.list({ scope: 'mine' });
    const row = (id: number) => ({ id, isStarred: false });
    queryClient.setQueryData(listKey, {
      pages: [{ items: [row(9), row(8)], nextCursor: 'c8', head: 'h1' }, { items: [row(7)], nextCursor: null }],
      pageParams: ['', 'c8'],
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useStarMutation(), { wrapper });
    result.current.mutate({ id: 8, starred: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const data = queryClient.getQueryData<{ pages: Array<{ head?: string; items: Array<{ id: number; isStarred: boolean }> }> }>(listKey);
    expect(data?.pages[0]?.items[1]?.isStarred).toBe(true);
    expect(data?.pages[0]?.head).toBeUndefined();
    queryClient.clear();
  });
});
