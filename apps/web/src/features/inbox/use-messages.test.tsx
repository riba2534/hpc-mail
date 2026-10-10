import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageSummary, Page } from '@hpc-mail/shared';
const list = vi.hoisted(() => vi.fn());
vi.mock('@/api/resources', () => ({ messageApi: { list } }));
import { queryKeys } from '@/api/query-keys';
import { useMessagesQuery } from './use-messages';

const mail = (id: number, extra: Partial<MessageSummary> = {}) =>
  ({ id, isRead: false, isStarred: false, status: 'received', ...extra }) as MessageSummary;
const first: Page<MessageSummary> = { items: [mail(3)], nextCursor: 'older' };
const older: Page<MessageSummary> = { items: [mail(2)], nextCursor: null };

function setup(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useMessagesQuery({ direction: 'inbound' }), { wrapper });
}

afterEach(() => {
  vi.restoreAllMocks();
  list.mockReset();
});

describe('multi-page inbox polling', () => {
  it('merges the probed head into the first page instead of refetching every cursor', async () => {
    let tick: (() => void) | undefined;
    const originalInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
      if (delay === 20_000) {
        tick = callback as () => void;
        return -137 as unknown as ReturnType<typeof setInterval>;
      }
      return originalInterval(callback, delay, ...args);
    });
    let head = first;
    list.mockImplementation(async (query: { cursor?: string }) => (query.cursor === 'older' ? older : head));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = setup(client);
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const olderItem = result.current.data!.pages[1]!.items[0];
    const baseline = list.mock.calls.length;

    // 新邮件到达 + 首条状态变化
    head = { items: [mail(4), mail(3, { isRead: true })], nextCursor: 'older' };
    act(() => tick?.());
    await waitFor(() => expect(result.current.data?.pages[0]?.items.map((m) => m.id)).toEqual([4, 3]));
    expect(result.current.data?.pages[0]?.items[1]?.isRead).toBe(true);
    expect(result.current.data?.pages[1]?.items[0]).toBe(olderItem);
    // 只发了 1 个首页探测请求，没有按游标重拉后续页
    expect(list.mock.calls.slice(baseline).map(([query]) => query.cursor)).toEqual([undefined]);
    client.clear();
  });

  it('probes once when a stale multi-page list mounts or the window regains focus', async () => {
    list.mockImplementation(async () => first);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.messages.list({ direction: 'inbound' }), {
      pages: [first, older],
      pageParams: ['', 'older'],
    });
    await client.invalidateQueries({ queryKey: queryKeys.messages.lists, refetchType: 'none' });
    const { result } = setup(client);
    expect(result.current.data?.pages).toHaveLength(2);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list.mock.calls[0]?.[0].cursor).toBeUndefined();
    await waitFor(() => expect(client.getQueryState(queryKeys.messages.list({ direction: 'inbound' }))?.isInvalidated).toBe(false));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls.every(([query]) => query.cursor === undefined)).toBe(true);
    focusManager.setFocused(undefined);
    client.clear();
  });
});
