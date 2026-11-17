import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageListPage, MessageSummary } from '@hpc-mail/shared';
const api = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn(), unreadCount: vi.fn() }));
vi.mock('@/api/resources', () => ({ messageApi: api }));
import { queryKeys } from '@/api/query-keys';
import { type MessageListData, syncReadState, syncStarState } from './message-cache';
import { useMessagesQuery } from './use-messages';
import { markUnreadRefreshed, nextUnreadRefreshDelay, useUnreadCount } from './use-unread-count';

const query: Partial<ListMessagesQuery> = { direction: 'inbound' };
const listKey = queryKeys.messages.list(query);
const mail = (id: number, extra: Partial<MessageSummary> = {}) =>
  ({ id, isRead: false, isStarred: false, status: 'received', ...extra }) as MessageSummary;
const page = (ids: number[], nextCursor: string | null, head?: string): MessageListPage => ({
  items: ids.map((id) => mail(id)),
  nextCursor,
  ...(head === undefined ? {} : { head }),
});
const ids = (data: { pages: MessageListPage[] } | undefined) => data?.pages.map((p) => p.items.map((m) => m.id));

const clients: QueryClient[] = [];
function createClient() {
  // 与生产一致：刚取到的列表挂载时不重拉，只由轮询驱动
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  clients.push(client);
  return client;
}
const wrapperOf = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
const renderList = (client: QueryClient) => renderHook(() => useMessagesQuery(query), { wrapper: wrapperOf(client) });

// 接管轮询定时器（列表 sync 的 20 秒周期与首轮等待、搜索视图的 60 秒周期、未读数自身的 refetchInterval），由 tick() 手动推进
const pollTimers = new Map<number, { callback: () => void; delay: number; once: boolean }>();
let nextTimerId = -1;
/** 走到下一个轮询点：到期的一次性定时器触发后移除，周期定时器保留 */
const tick = () => act(() => {
  for (const [id, timer] of [...pollTimers]) {
    if (timer.once) pollTimers.delete(id);
    timer.callback();
  }
});
const pendingFirstRounds = () => [...pollTimers.values()].filter((timer) => timer.once).map((timer) => timer.delay);
// 失败后的静默重试延迟（2.5 秒）同样接管，由 fireRetry() 手动推进
const retryTimers = new Map<number, () => void>();
const fireRetry = () => act(() => {
  const callbacks = [...retryTimers.values()];
  retryTimers.clear();
  callbacks.forEach((callback) => callback());
});
/** 让已发出的请求与随后的缓存写入落定 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 20_000 && delay !== 60_000) return realSetInterval(callback, delay, ...args);
    const id = nextTimerId--;
    pollTimers.set(id, { callback, delay, once: false });
    return id;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id?: number) => {
    if (id === undefined || !pollTimers.delete(id)) realClearInterval(id);
  }) as typeof clearInterval);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    const id = nextTimerId--;
    if (delay === 2_500) retryTimers.set(id, callback);
    else if (delay !== undefined && ((delay > 2_500 && delay <= 20_000) || delay === 60_000)) pollTimers.set(id, { callback, delay, once: true });
    else return realSetTimeout(callback, delay, ...args);
    return id;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id?: number) => {
    if (id === undefined || !(retryTimers.delete(id) || pollTimers.delete(id))) realClearTimeout(id);
  }) as typeof clearTimeout);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  pollTimers.clear();
  retryTimers.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe('list polling via /messages/sync', () => {
  it('sends only the sync request while the head is unchanged and writes its unread count', async () => {
    api.list.mockResolvedValue(page([3, 2], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 4, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(ids(result.current.data)).toEqual([[3, 2]]));

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.sync).toHaveBeenCalledWith(query, expect.any(AbortSignal));
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 4 });
  });

  it('refetches a single-page list as a whole when the head changed, then stays quiet', async () => {
    api.list.mockResolvedValueOnce(page([3, 2], null, 'h1')).mockResolvedValue(page([4, 3, 2], null, 'h2'));
    api.sync.mockResolvedValue({ unread: 1, head: 'h2' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(ids(result.current.data)).toEqual([[3, 2]]));

    await tick();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3, 2]]));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list.mock.calls[1]?.[0].cursor).toBeUndefined();

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('merges the head page into a multi-page list instead of refetching every cursor', async () => {
    let head = page([3], 'older', 'h1');
    api.list.mockImplementation(async (params: { cursor?: string }) => (params.cursor === 'older' ? page([2], null) : head));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    const olderItem = result.current.data!.pages[1]!.items[0];
    const baseline = api.list.mock.calls.length;

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(baseline);

    // 新邮件到达 + 首条状态变化
    head = { items: [mail(4), mail(3, { isRead: true })], nextCursor: 'older', head: 'h2' };
    api.sync.mockResolvedValue({ unread: 0, head: 'h2' });
    await tick();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3], [2]]));
    expect(result.current.data?.pages[0]?.items[1]?.isRead).toBe(true);
    expect(result.current.data?.pages[1]?.items[0]).toBe(olderItem);
    expect(result.current.data?.pages[0]?.head).toBe('h2');
    // 只发了 1 个首页探测请求，没有按游标重拉后续页
    expect(api.list.mock.calls.slice(baseline).map(([params]) => params.cursor)).toEqual([undefined]);

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(3));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(baseline + 1);
  });

  it('treats a first page without head (persisted by an older build) as changed once', async () => {
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], null)], pageParams: [''] });
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const { result } = renderList(client);
    await settle();
    expect(api.list).not.toHaveBeenCalled();

    await tick();
    await waitFor(() => expect(result.current.data?.pages[0]?.head).toBe('h1'));
    expect(api.list).toHaveBeenCalledTimes(1);

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('pauses the unread-count polling while a list view polls, and resumes it afterwards', async () => {
    const client = createClient();
    api.unreadCount.mockResolvedValue({ unread: 1 });
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 5, head: 'h1' });
    const unread = renderHook(() => useUnreadCount(), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(unread.result.current.data).toEqual({ unread: 1 }));
    const list = renderList(client);
    await waitFor(() => expect(list.result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(unread.result.current.data).toEqual({ unread: 5 }));
    // 聚焦时同样只检查一次 sync
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    await settle();
    expect(api.unreadCount).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);

    // 离开列表视图后未读数恢复自己的轮询
    list.unmount();
    await tick();
    await waitFor(() => expect(api.unreadCount).toHaveBeenCalledTimes(2));
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('drops the round while a mutation is pending, and skips hidden tabs', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 9, head: 'h2' });
    const client = createClient();
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 1 });
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    const mutation = client.getMutationCache().build(client, { mutationFn: () => new Promise<never>(() => {}) });
    void mutation.execute(undefined);
    await waitFor(() => expect(client.isMutating()).toBe(1));
    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 1 });
    client.getMutationCache().clear();

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it('retries a single failed sync quietly after a short delay without overlapping the next round', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockRejectedValueOnce(new Error('网络异常')).mockResolvedValue({ unread: 2, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(retryTimers.size).toBe(1));
    expect(result.current.isError).toBe(false);
    // 重试等待期间定时器到点：沿用 pending，不并发再发一次
    await tick();
    await settle();
    expect(api.sync).toHaveBeenCalledTimes(1);

    await fireRetry();
    await waitFor(() => expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 2 }));
    expect(api.sync).toHaveBeenCalledTimes(2);
    expect(result.current.isError).toBe(false);
  });

  it('reports two consecutive failures and clears the error on the next successful round', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockRejectedValueOnce(new Error('网络异常'))
      .mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(retryTimers.size).toBe(1));
    await fireRetry();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('网络异常');
    expect(result.current.data?.pages[0]?.items).toHaveLength(1);

    await tick();
    await waitFor(() => expect(result.current.isError).toBe(false));
    expect(api.sync).toHaveBeenCalledTimes(3);
  });

  it('skips rounds while offline and checks once the connection is back', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => onlineManager.setOnline(false));
    await tick();
    await settle();
    expect(api.sync).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(false);

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
  });

  it('retries the head probe of a stale multi-page list the same way', async () => {
    api.list.mockRejectedValueOnce(new Error('网络异常')).mockResolvedValue(page([4, 3], 'older', 'h2'));
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], 'older', 'h1'), page([2], null)], pageParams: ['', 'older'] });
    await client.invalidateQueries({ queryKey: queryKeys.messages.lists, refetchType: 'none' });
    const { result } = renderList(client);
    await waitFor(() => expect(retryTimers.size).toBe(1));
    expect(result.current.isError).toBe(false);

    await fireRetry();
    await waitFor(() => expect(ids(result.current.data)).toEqual([[4, 3], [2]]));
    expect(api.list.mock.calls.map(([params]) => params.cursor)).toEqual([undefined, undefined]);
    expect(api.sync).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(false);
  });

  it('probes the head once when a stale multi-page list mounts, then checks sync on focus', async () => {
    api.list.mockResolvedValue(page([3], 'older', 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    client.setQueryData<MessageListData>(listKey, { pages: [page([3], 'older', 'h1'), page([2], null)], pageParams: ['', 'older'] });
    await client.invalidateQueries({ queryKey: queryKeys.messages.lists, refetchType: 'none' });
    const { result } = renderList(client);
    expect(result.current.data?.pages).toHaveLength(2);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    expect(api.list.mock.calls[0]?.[0].cursor).toBeUndefined();
    expect(api.sync).not.toHaveBeenCalled();
    await waitFor(() => expect(client.getQueryState(listKey)?.isInvalidated).toBe(false));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('writes the unread count even when the list was edited in place during the round', async () => {
    api.list.mockResolvedValue(page([3, 2], null, 'h1'));
    let resolveSync: (value: { unread: number; head: string }) => void = () => {};
    api.sync.mockImplementation(() => new Promise((resolve) => (resolveSync = resolve)));
    const client = createClient();
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 1 });
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data).toBeDefined());

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    // sync 在途时本地就地改了列表（如加星标）：列表这一轮不重拉，未读数照常写入
    act(() => syncStarState(client, [3], true, { refetchActive: false }));
    await act(async () => resolveSync({ unread: 7, head: 'h2' }));
    await waitFor(() => expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 7 }));
    await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('re-aligns a first page edited in place even when the server head is back to its old value (ABA)', async () => {
    api.list.mockImplementation(async (params: { cursor?: string }) => (params.cursor === 'older' ? page([2], null) : page([3], 'older', 'h0')));
    // 本地标为已读后，别处又把它改回未读：服务端首页恢复为 h0
    api.sync.mockResolvedValue({ unread: 1, head: 'h0' });
    const client = createClient();
    const { result } = renderList(client);
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    act(() => syncReadState(client, [3], true));
    const edited = client.getQueryData<MessageListData>(listKey);
    expect(edited?.pages[0]?.items[0]?.isRead).toBe(true);
    expect(edited?.pages[0]?.head).toBeUndefined();
    await tick();
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.isRead).toBe(false));
    expect(result.current.data?.pages[0]?.head).toBe('h0');
  });
});

describe('first round after a list view mounts', () => {
  it('waits only for the rest of the interval after a recent sync when switching filters', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    const first = renderList(client);
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    first.unmount();

    const unreadOnly = { direction: 'inbound' as const, unread: true };
    const other = renderHook(() => useMessagesQuery(unreadOnly), { wrapper: wrapperOf(client) });
    await waitFor(() => expect(other.result.current.data).toBeDefined());
    await settle();
    // 刚 sync 过：不立即再发，首轮只等剩余的时间，而不是重新等满 20 秒
    expect(api.sync).toHaveBeenCalledTimes(1);
    const [delay] = pendingFirstRounds();
    expect(delay).toBeLessThan(20_000);
    expect(delay).toBeGreaterThan(15_000);
    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    expect(api.sync.mock.calls[1]?.[0]).toEqual(unreadOnly);
  });

  it('checks right away when the last refresh is a full interval old', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    const client = createClient();
    markUnreadRefreshed(client, Date.now() - 25_000);
    renderList(client);
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    expect(pendingFirstRounds()).toEqual([]);
  });

  it('measures from the unread-count refresh too, and waits a full interval without any record', async () => {
    const client = createClient();
    expect(nextUnreadRefreshDelay(client)).toBe(20_000);
    const now = Date.now();
    markUnreadRefreshed(client, now - 5_000);
    expect(nextUnreadRefreshDelay(client, now)).toBe(15_000);
    markUnreadRefreshed(client, now - 25_000);
    expect(nextUnreadRefreshDelay(client, now)).toBe(0);

    const fresh = createClient();
    api.unreadCount.mockResolvedValue({ unread: 1 });
    const unread = renderHook(() => useUnreadCount(), { wrapper: wrapperOf(fresh) });
    await waitFor(() => expect(unread.result.current.data).toEqual({ unread: 1 }));
    expect(nextUnreadRefreshDelay(fresh)).toBeLessThan(20_000);
  });
});

describe('switching filters and searching', () => {
  it('keeps showing the previous results instead of a loading state until the new ones arrive', async () => {
    let resolveSearch: (value: MessageListPage) => void = () => {};
    api.list
      .mockResolvedValueOnce(page([3, 2], null, 'h1'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSearch = resolve)));
    const client = createClient();
    const { result, rerender } = renderHook(
      ({ q }: { q?: string }) => useMessagesQuery({ direction: 'inbound', q }),
      { initialProps: {} as { q?: string }, wrapper: wrapperOf(client) },
    );
    await waitFor(() => expect(ids(result.current.data)).toEqual([[3, 2]]));
    expect(result.current.isPlaceholderData).toBe(false);

    rerender({ q: 'invoice' });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(ids(result.current.data)).toEqual([[3, 2]]);

    await act(async () => resolveSearch(page([9], null, 'h9')));
    await waitFor(() => expect(ids(result.current.data)).toEqual([[9]]));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('probes a search view every 60 seconds and leaves the unread count polling by itself', async () => {
    api.list.mockResolvedValue(page([3], null, 'h1'));
    api.sync.mockResolvedValue({ unread: 0, head: 'h1' });
    api.unreadCount.mockResolvedValue({ unread: 0 });
    const client = createClient();
    // 非搜索视图此时会立即 sync（见上一组用例）；搜索词刚整体拉取过，等满 60 秒
    markUnreadRefreshed(client, Date.now() - 25_000);
    const search = { direction: 'inbound' as const, q: 'invoice' };
    const { result } = renderHook(() => {
      useUnreadCount();
      return useMessagesQuery(search);
    }, { wrapper: wrapperOf(client) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await settle();
    expect(api.sync).not.toHaveBeenCalled();
    // 负载高时未读数查询的过期通知定时器也可能落进 20 秒以内被接管，只断言列表首轮
    expect(pendingFirstRounds()).toContain(60_000);

    await tick();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
    expect(api.sync).toHaveBeenCalledWith(search, expect.any(AbortSignal));
    // 列表按 60 秒探测首页；未读数没有被暂停，仍按自己的 20 秒刷新
    const intervals = [...pollTimers.values()].filter((timer) => !timer.once).map((timer) => timer.delay);
    expect(intervals.sort((a, b) => a - b)).toEqual([20_000, 60_000]);
  });
});
