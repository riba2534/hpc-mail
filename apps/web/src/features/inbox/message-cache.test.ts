import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageSummary, Page } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import {
  mergeHeadPage,
  type MessageListData,
  syncAllRead,
  syncReadState,
  snapshotListMembership,
  syncRemovedMessages,
  syncRestoredMessages,
  syncStarState,
} from './message-cache';

const mail = (id: number, extra: Partial<MessageSummary> = {}) =>
  ({ id, direction: 'inbound', isRead: false, isStarred: false, status: 'received', ...extra }) as MessageSummary;
const page = (ids: number[], nextCursor: string | null, extra: Partial<MessageSummary> = {}): Page<MessageSummary> => ({
  items: ids.map((id) => mail(id, extra)),
  nextCursor,
});
const data = (...pages: Page<MessageSummary>[]): MessageListData => ({
  pages,
  pageParams: pages.map((_, index) => (index === 0 ? '' : `c${index}`)),
});
const ids = (value: MessageListData | undefined) => value?.pages.map((p) => p.items.map((m) => m.id));

describe('mergeHeadPage', () => {
  const loaded = data(page([10, 9, 8], 'c8'), page([7, 6, 5], 'c5'), page([4, 3], 'c3'));

  it('inserts new mail at the front and keeps untouched items and cursors', () => {
    const merged = mergeHeadPage(loaded, page([12, 11, 10], 'c10'));
    expect(ids(merged)).toEqual([[12, 11, 10, 9, 8], [7, 6, 5], [4, 3]]);
    expect(merged.pages[0]!.items[2]).toBe(loaded.pages[0]!.items[0]);
    expect(merged.pages[1]!.items[0]).toBe(loaded.pages[1]!.items[0]);
    expect(merged.pages[2]!.nextCursor).toBe('c3');
    expect(merged.pageParams).toEqual(loaded.pageParams);
  });

  it('replaces changed items and drops items that left the view within the head range', () => {
    const head: Page<MessageSummary> = { items: [mail(10, { isRead: true }), mail(8), mail(7)], nextCursor: 'c7' };
    const merged = mergeHeadPage(loaded, head);
    expect(ids(merged)).toEqual([[10, 8, 7], [6, 5], [4, 3]]);
    expect(merged.pages[0]!.items[0]!.isRead).toBe(true);
    expect(merged.pages[0]!.items[1]).toBe(loaded.pages[0]!.items[2]);
  });

  it('returns the same reference when nothing changed', () => {
    expect(mergeHeadPage(loaded, page([10, 9, 8], 'c8'))).toBe(loaded);
  });

  it('keeps only the head when it cannot be spliced onto the loaded pages', () => {
    // 新邮件超过一页：首页与已加载数据之间可能有缺口
    expect(ids(mergeHeadPage(loaded, page([30, 29, 28], 'c28')))).toEqual([[30, 29, 28]]);
    // 视图缩到一页以内
    expect(ids(mergeHeadPage(loaded, page([10, 3], null)))).toEqual([[10, 3]]);
    // 首页已越过全部已加载数据，末页游标会与首页重叠
    expect(ids(mergeHeadPage(loaded, page([10, 2, 1], 'c1')))).toEqual([[10, 2, 1]]);
  });
});

describe('cache sync after mutations', () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear());
  });

  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    clients.push(client);
    const fetchList = vi.fn(async (): Promise<Page<MessageSummary>> => page([3, 2, 1], null));
    const seedList = (filters: Partial<ListMessagesQuery>, value: MessageListData) =>
      client.setQueryData(queryKeys.messages.list(filters), value);
    const observeList = (filters: Partial<ListMessagesQuery>) =>
      new InfiniteQueryObserver(client, {
        queryKey: queryKeys.messages.list(filters),
        queryFn: fetchList,
        initialPageParam: '',
        getNextPageParam: (last: Page<MessageSummary>) => last.nextCursor ?? undefined,
      }).subscribe(() => {});
    const fetchUnread = vi.fn(async () => ({ unread: 0 }));
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 2 });
    // 未读数在 AppShell 中常驻激活
    new QueryObserver(client, { queryKey: queryKeys.messages.unreadCount, queryFn: fetchUnread }).subscribe(() => {});
    const list = (filters: Partial<ListMessagesQuery>) => client.getQueryData<MessageListData>(queryKeys.messages.list(filters));
    const listState = (filters: Partial<ListMessagesQuery>) => client.getQueryState(queryKeys.messages.list(filters));
    return { client, fetchList, fetchUnread, seedList, observeList, list, listState };
  }

  it('marks one mail read in every list and detail without refetching inactive lists', async () => {
    const { client, fetchList, fetchUnread, seedList, list, listState } = setup();
    const inbox = { direction: 'inbound' as const, scope: 'mine' as const };
    const unread = { ...inbox, unread: true };
    seedList(inbox, data(page([3, 2], 'c2'), page([1], null)));
    seedList(unread, data(page([3, 2], null)));
    client.setQueryData(queryKeys.messages.detail(2), mail(2));
    client.setQueryData(queryKeys.messages.detail(2, { scope: 'unclaimed' }), mail(2));
    const untouched = list(inbox)?.pages[0]?.items[0];

    syncReadState(client, [2], true);

    expect(list(inbox)?.pages[0]?.items.find((m) => m.id === 2)?.isRead).toBe(true);
    expect(list(inbox)?.pages[0]?.items[0]).toBe(untouched);
    expect(ids(list(unread))).toEqual([[3]]);
    expect(client.getQueryData<MessageSummary>(queryKeys.messages.detail(2))?.isRead).toBe(true);
    expect(client.getQueryData<MessageSummary>(queryKeys.messages.detail(2, { scope: 'unclaimed' }))?.isRead).toBe(true);
    expect(listState(inbox)?.isInvalidated).toBe(true);
    await vi.waitFor(() => expect(fetchUnread).toHaveBeenCalledTimes(1));
    expect(fetchList).not.toHaveBeenCalled();
  });

  it('refetches only an active single-page list after a batch change', async () => {
    const { client, fetchList, seedList, observeList, listState } = setup();
    const single = { scope: 'mine' as const, starred: true };
    const multi = { scope: 'mine' as const };
    seedList(single, data(page([3, 2], null)));
    seedList(multi, data(page([3, 2], 'c2'), page([1], null)));
    const stopSingle = observeList(single);
    const stopMulti = observeList(multi);

    syncStarState(client, [3], true);

    await vi.waitFor(() => expect(listState(single)?.isInvalidated).toBe(false));
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(listState(multi)?.isInvalidated).toBe(true);
    stopSingle();
    stopMulti();
  });

  it('single star toggle updates starred lists without any request', async () => {
    const { client, fetchList, fetchUnread, seedList, observeList, list, listState } = setup();
    const starred = { scope: 'mine' as const, starred: true };
    const inbox = { scope: 'mine' as const };
    seedList(starred, data(page([3, 2], null, { isStarred: true })));
    seedList(inbox, data(page([3, 2], 'c2'), page([1], null)));
    const stop = observeList(starred);

    syncStarState(client, [2], false, { refetchActive: false });
    syncStarState(client, [1], true, { refetchActive: false });

    expect(ids(list(starred))).toEqual([[3]]);
    expect(list(inbox)?.pages[1]?.items[0]?.isStarred).toBe(true);
    expect(listState(starred)?.isInvalidated).toBe(true);
    expect(listState(inbox)?.isInvalidated).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchList).not.toHaveBeenCalled();
    expect(fetchUnread).not.toHaveBeenCalled();
    stop();
  });

  it('removes deleted mail from live lists and marks trash stale', async () => {
    const { client, seedList, list, listState, fetchUnread } = setup();
    const inbox = { scope: 'mine' as const };
    const trash = { scope: 'mine' as const, trash: true };
    seedList(inbox, data(page([3, 2], 'c2'), page([1], null)));
    seedList(trash, data(page([9], null)));

    syncRemovedMessages(client, [2, 1], 'live');

    expect(ids(list(inbox))).toEqual([[3], []]);
    expect(ids(list(trash))).toEqual([[9]]);
    expect(listState(trash)?.isInvalidated).toBe(true);
    await vi.waitFor(() => expect(fetchUnread).toHaveBeenCalledTimes(1));

    syncRemovedMessages(client, [9], 'trash');
    expect(ids(list(trash))).toEqual([[]]);
  });

  it('read-all only touches inbound mail in personal lists', () => {
    const { client, seedList, list } = setup();
    const inbox = { scope: 'mine' as const };
    const unread = { scope: 'mine' as const, unread: true };
    const unclaimed = { scope: 'unclaimed' as const };
    seedList(inbox, data({ items: [mail(3), mail(2, { direction: 'outbound' })], nextCursor: null }));
    seedList(unread, data(page([3], null)));
    seedList(unclaimed, data(page([7], null)));

    syncAllRead(client);

    expect(list(inbox)?.pages[0]?.items.map((m) => m.isRead)).toEqual([true, false]);
    expect(ids(list(unread))).toEqual([[]]);
    expect(list(unclaimed)?.pages[0]?.items[0]?.isRead).toBe(false);
  });

  it('scoped read-all skips other domains and shared mail, and leaves keyword scopes to the server', () => {
    const { client, seedList, list, listState } = setup();
    const inbox = { scope: 'mine' as const };
    seedList(inbox, data({
      items: [
        mail(4, { domain: 'a.example', address: 'me@a.example' }),
        mail(3, { domain: 'a.example', address: 'shared@a.example' }),
        mail(2, { domain: 'b.example', address: 'me@b.example' }),
      ],
      nextCursor: null,
    }));

    syncAllRead(client, { domain: 'a.example', ownedAddresses: new Set(['me@a.example', 'me@b.example']) });
    expect(list(inbox)?.pages[0]?.items.map((m) => m.isRead)).toEqual([true, false, false]);

    syncAllRead(client, { q: 'invoice' });
    expect(list(inbox)?.pages[0]?.items.map((m) => m.isRead)).toEqual([true, false, false]);
    expect(listState(inbox)?.isInvalidated).toBe(true);
  });

  it('undo puts deleted mail back into the lists it came from, in order', () => {
    const { client, seedList, list } = setup();
    const inbox = { scope: 'mine' as const };
    const unread = { scope: 'mine' as const, unread: true };
    const trash = { scope: 'mine' as const, trash: true };
    seedList(inbox, data(page([9, 8], 'c8'), page([7, 6], null)));
    seedList(unread, data(page([8, 6], null)));
    seedList(trash, data(page([], null)));

    const membership = snapshotListMembership(client, [8, 6]);
    syncRemovedMessages(client, [8, 6], 'live');
    expect(ids(list(inbox))).toEqual([[9], [7]]);
    seedList(trash, data(page([8, 6], null)));

    syncRestoredMessages(client, [8, 6], membership);
    expect(ids(list(inbox))).toEqual([[9, 8], [7, 6]]);
    expect(ids(list(unread))).toEqual([[8, 6]]);
    expect(ids(list(trash))).toEqual([[]]);
  });
});
