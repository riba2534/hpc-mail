import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const starMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/api/resources', () => ({ messageApi: { star: starMock } }));

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
});
