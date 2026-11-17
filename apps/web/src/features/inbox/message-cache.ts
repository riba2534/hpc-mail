import type { InfiniteData, Query, QueryClient, QueryKey } from '@tanstack/react-query';
import type { ListMessagesQuery, MessageDetail, MessageListPage, MessageSummary } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { markUnreadRefreshed } from './use-unread-count';

export type MessageListData = InfiniteData<MessageListPage, string>;
type ListFilters = Partial<ListMessagesQuery>;
type ListPredicate = (filters: ListFilters) => boolean;

const filtersOf = (query: Query): ListFilters => (query.queryKey[2] ?? {}) as ListFilters;
const pageCount = (query: Query): number => (query.state.data as MessageListData | undefined)?.pages.length ?? 0;
const isMineList: ListPredicate = (filters) => (filters.scope ?? 'mine') === 'mine' && !filters.trash;

/**
 * 本地就地改写了首页条目后，首页已不是服务端算 head 时的内容：去掉 head，下一轮 sync 按「有变化」对齐一次。
 * 否则服务端首页在下一次 sync 前恢复原状（ABA，如在别处又改了回去）时 head 相同，本地改动会一直留着。
 */
function dropStaleHead<T extends { pages: Array<{ head?: string }> }>(data: T, previous: T): T {
  const [first] = data.pages;
  if (!first || first === previous.pages[0] || first.head === undefined) return data;
  return { ...data, pages: [{ ...first, head: undefined }, ...data.pages.slice(1)] };
}

/** 逐条变换一份列表缓存（返回 null 表示移出该列表）；没有条目变化时返回 undefined，调用方据此跳过写入 */
export function patchListItems<T extends { pages: Array<{ head?: string; items: MessageSummary[] }> }>(
  data: T,
  map: (item: MessageSummary) => MessageSummary | null,
): T | undefined {
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.flatMap((item) => {
      const next = map(item);
      if (next !== item) pageChanged = true;
      return next ? [next] : [];
    });
    changed ||= pageChanged;
    return pageChanged ? { ...page, items } : page;
  });
  return changed ? dropStaleHead({ ...data, pages }, data) : undefined;
}

/**
 * 逐条变换所有匹配的列表缓存（返回 null 表示移出该列表）。
 * 没有条目变化的列表返回 undefined 跳过写入，避免无谓刷新 dataUpdatedAt 和重渲染。
 */
function updateLists(
  client: QueryClient,
  map: (item: MessageSummary, filters: ListFilters) => MessageSummary | null,
  predicate: ListPredicate = () => true,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.messages.lists })) {
    const filters = filtersOf(query);
    if (!predicate(filters)) continue;
    client.setQueryData<MessageListData>(query.queryKey, (data) => data && patchListItems(data, (item) => map(item, filters)));
  }
}

function patchDetails(client: QueryClient, ids: ReadonlySet<number>, patch: Partial<MessageDetail>): void {
  client.setQueriesData<MessageDetail>(
    { queryKey: queryKeys.messages.details, predicate: (query) => ids.has(query.queryKey[2] as number) },
    (detail) => (detail ? { ...detail, ...patch } : undefined),
  );
}

/**
 * 列表统一收尾：全部只标记过期、不立即重拉；仅当前显示且只有 1 页的列表立即重拉（1 个请求）。
 * 多页列表已由就地更新保持一致，过期标记让下次挂载/聚焦/轮询时经首页探测增量对齐，不再串行重拉每一页。
 */
function refreshLists(client: QueryClient, predicate: ListPredicate = () => true): void {
  const matches = (query: Query) => predicate(filtersOf(query));
  void client.invalidateQueries({ queryKey: queryKeys.messages.lists, predicate: matches, refetchType: 'none' });
  void client.refetchQueries({
    queryKey: queryKeys.messages.lists,
    type: 'active',
    predicate: (query) => matches(query) && pageCount(query) <= 1,
  });
}

function refreshUnreadCount(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.messages.unreadCount });
}

/**
 * 写入服务端随标已读带回的未读数，省掉一次重拉。在途的未读数请求发出得更早、结果更旧，先取消再写；
 * 还有别的写操作在途（本次标记自身之外）时口径可能又变了，退回失效重拉。
 */
async function applyUnreadCount(client: QueryClient, unread: number): Promise<void> {
  if (client.isMutating() > 1) return refreshUnreadCount(client);
  await client.cancelQueries({ queryKey: queryKeys.messages.unreadCount, exact: true });
  client.setQueryData(queryKeys.messages.unreadCount, { unread });
  markUnreadRefreshed(client);
}

/**
 * 已读/未读变更成功后：就地更新列表与详情，已读邮件移出「未读」筛选，未读数立即更新——
 * 服务端已带回未读数（unread）时直接写入，否则失效重拉。
 */
export function syncReadState(client: QueryClient, ids: readonly number[], isRead: boolean, unread?: number): void {
  const idSet = new Set(ids);
  patchDetails(client, idSet, { isRead });
  updateLists(client, (item, filters) => {
    if (!idSet.has(item.id)) return item;
    if (isRead && filters.unread) return null;
    return item.isRead === isRead ? item : { ...item, isRead };
  });
  refreshLists(client);
  if (unread === undefined) refreshUnreadCount(client);
  else void applyUnreadCount(client, unread);
}

/**
 * 星标变更后同步缓存：取消星标的邮件移出「星标」列表；新加星标的邮件要插入星标列表，只能标记过期。
 * 单封切换已做乐观更新，传 refetchActive=false 不再发任何请求。
 */
export function syncStarState(
  client: QueryClient,
  ids: readonly number[],
  starred: boolean,
  { refetchActive = true }: { refetchActive?: boolean } = {},
): void {
  const idSet = new Set(ids);
  patchDetails(client, idSet, { isStarred: starred });
  updateLists(client, (item, filters) => {
    if (!idSet.has(item.id)) return item;
    if (!starred && filters.starred) return null;
    return item.isStarred === starred ? item : { ...item, isStarred: starred };
  });
  if (refetchActive) {
    refreshLists(client);
    return;
  }
  void client.invalidateQueries({
    queryKey: queryKeys.messages.lists,
    predicate: (query) => Boolean(filtersOf(query).starred),
    refetchType: 'none',
  });
}

/** 删除（from='live'）、恢复或永久删除（from='trash'）后：从来源列表就地移除，另一侧列表标记过期。 */
export function syncRemovedMessages(client: QueryClient, ids: readonly number[], from: 'live' | 'trash'): void {
  const idSet = new Set(ids);
  updateLists(
    client,
    (item) => (idSet.has(item.id) ? null : item),
    (filters) => Boolean(filters.trash) === (from === 'trash'),
  );
  void client.invalidateQueries({
    queryKey: queryKeys.messages.details,
    predicate: (query) => idSet.has(query.queryKey[2] as number),
    refetchType: 'none',
  });
  refreshLists(client);
  refreshUnreadCount(client);
}

/** 全部已读的作用范围：与请求体一致；ownedAddresses 用于跳过共享给自己的邮件（它们的已读状态不变） */
export interface ReadAllScope {
  domain?: string;
  address?: string;
  q?: string;
  ownedAddresses?: ReadonlySet<string>;
}

/**
 * 全部已读（个人邮箱的收件）：就地标记命中范围的邮件已读并移出「未读」筛选，详情只标记过期。
 * 关键词范围无法在本地判断，只标记过期由服务端结果对齐。
 */
export function syncAllRead(client: QueryClient, scope: ReadAllScope = {}): void {
  if (!scope.q) {
    updateLists(
      client,
      (item, filters) => {
        if (item.direction !== 'inbound') return item;
        if (scope.domain && item.domain !== scope.domain) return item;
        if (scope.address && item.address !== scope.address) return item;
        if (scope.ownedAddresses && !scope.ownedAddresses.has(item.address)) return item;
        if (filters.unread) return null;
        return item.isRead ? item : { ...item, isRead: true };
      },
      isMineList,
    );
  }
  void client.invalidateQueries({ queryKey: queryKeys.messages.details, refetchType: 'none' });
  refreshLists(client);
  refreshUnreadCount(client);
}

/**
 * 发信成功后：新邮件（已发送的一封，以及站内投递到的收件）只会出现在非星标、非回收站的列表里，
 * 这些列表标记过期（当前显示的单页列表立即重拉），回到列表时经整页重拉或首页探测对齐。
 * 回复/转发/补发的来源邮件所在会话线程标记过期；详情不受发信影响，保持原样。
 * 发给自己认领的地址时站内直接投递，未读数一并刷新。
 */
export function syncSentMessage(
  client: QueryClient,
  { sourceIds, selfDelivered }: { sourceIds: readonly number[]; selfDelivered: boolean },
): void {
  refreshLists(client, (filters) => !filters.starred && !filters.trash);
  const sources = new Set(sourceIds);
  if (sources.size > 0) {
    void client.invalidateQueries({
      queryKey: queryKeys.messages.root,
      predicate: (query) => {
        if (query.queryKey[1] !== 'thread') return false;
        const items = (query.state.data as { items?: MessageSummary[] } | undefined)?.items ?? [];
        return sources.has(query.queryKey[2] as number) || items.some((item) => sources.has(item.id));
      },
      refetchType: 'none',
    });
  }
  if (selfDelivered) refreshUnreadCount(client);
}

/** 自己认领的地址（小写），用来判断发信是否投递给了自己 */
export function ownedAddressSet(mailboxes: readonly { address: string }[] | undefined): Set<string> {
  return new Set((mailboxes ?? []).map((box) => box.address.toLowerCase()));
}

/** 发信成功后（写信页与草稿箱共用）：见 syncSentMessage；收件人里有自己认领的地址算站内投递，新收件人进入往来联系人 */
export function syncAfterSend(
  client: QueryClient,
  { sourceIds, recipients, owned }: { sourceIds: readonly number[]; recipients: readonly { address: string }[]; owned: ReadonlySet<string> },
): void {
  syncSentMessage(client, { sourceIds, selfDelivered: recipients.some((recipient) => owned.has(recipient.address)) });
  void client.invalidateQueries({ queryKey: queryKeys.messages.contacts, refetchType: 'none' });
}

/** 删除前各列表里这批邮件的快照，撤销时据此放回原列表 */
export type ListMembership = Array<{ queryKey: QueryKey; items: MessageSummary[] }>;

export function snapshotListMembership(client: QueryClient, ids: readonly number[]): ListMembership {
  const idSet = new Set(ids);
  const snapshot: ListMembership = [];
  for (const query of client.getQueryCache().findAll({ queryKey: queryKeys.messages.lists })) {
    if (filtersOf(query).trash) continue;
    const data = query.state.data as MessageListData | undefined;
    const items = data?.pages.flatMap((page) => page.items.filter((item) => idSet.has(item.id))) ?? [];
    if (items.length > 0) snapshot.push({ queryKey: query.queryKey, items });
  }
  return snapshot;
}

/** 按 id 倒序把条目插回分页列表（已存在的不重复插入） */
function insertById(data: MessageListData, items: MessageSummary[]): MessageListData {
  const present = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)));
  const pages = data.pages.map((page) => ({ ...page, items: [...page.items] }));
  const firstLength = pages[0]?.items.length;
  for (const item of items) {
    if (present.has(item.id)) continue;
    let target = pages.findIndex((page) => page.items.some((existing) => existing.id < item.id));
    let position = target === -1 ? -1 : pages[target]!.items.findIndex((existing) => existing.id < item.id);
    // 落在两页之间时接到上一页末尾，保持原有的页边界与游标语义
    if (target === -1 || (position === 0 && target > 0)) {
      target = target === -1 ? pages.length - 1 : target - 1;
      position = -1;
    }
    const page = pages[target];
    if (!page) continue;
    page.items.splice(position === -1 ? page.items.length : position, 0, item);
    present.add(item.id);
  }
  // 插回了首页：首页同样不再是服务端算 head 时的内容
  if (pages[0] && pages[0].items.length !== firstLength) pages[0] = { ...pages[0], head: undefined };
  return { ...data, pages };
}

/** 撤销删除（恢复成功）后：放回删除前所在的列表，从回收站列表移除，未读数刷新。 */
export function syncRestoredMessages(client: QueryClient, ids: readonly number[], membership: ListMembership): void {
  const idSet = new Set(ids);
  for (const { queryKey, items } of membership) {
    const restored = items.filter((item) => idSet.has(item.id));
    if (restored.length === 0) continue;
    client.setQueryData<MessageListData>(queryKey, (data) => (data ? insertById(data, restored) : undefined));
  }
  updateLists(client, (item) => (idSet.has(item.id) ? null : item), (filters) => Boolean(filters.trash));
  void client.invalidateQueries({
    queryKey: queryKeys.messages.details,
    predicate: (query) => idSet.has(query.queryKey[2] as number),
    refetchType: 'none',
  });
  refreshLists(client);
  refreshUnreadCount(client);
}

const sameSummary = (a: MessageSummary, b: MessageSummary) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * 把轮询拿到的首页合并进多页列表，避免整串重拉。列表按 id 倒序、游标为 keyset（id < cursor），
 * 所以首页覆盖「id ≥ 首页最后一条」的区间：区间内的已加载条目整体换成首页内容（新邮件插到最前、
 * 状态变化按 id 替换、缺失的视为已删除或移出筛选），区间外保持不动，末页游标依旧有效。
 * 新邮件多到首页接不上已加载数据，或首页已越过全部已加载数据时，无法安全拼接，只保留首页。
 * 未变化的条目沿用旧引用，行组件 memo 不会重渲染。首页的 head 指纹换成探测结果的，供下一轮 sync 比较。
 */
export function mergeHeadPage(data: MessageListData, head: MessageListPage): MessageListData {
  const loaded = data.pages.flatMap((page) => page.items);
  const onlyHead = (): MessageListData => ({ pages: [head], pageParams: [data.pageParams[0] ?? ''] });
  const oldestHead = head.items[head.items.length - 1];
  const newestLoaded = loaded[0];
  const oldestLoaded = loaded[loaded.length - 1];
  if (head.nextCursor === null || !oldestHead || !newestLoaded || !oldestLoaded) return onlyHead();
  if (oldestHead.id > newestLoaded.id || oldestHead.id < oldestLoaded.id) return onlyHead();

  const loadedById = new Map(loaded.map((item) => [item.id, item]));
  const headItems = head.items.map((item) => {
    const previous = loadedById.get(item.id);
    return previous && sameSummary(previous, item) ? previous : item;
  });
  const pages = data.pages.map((page, index) => {
    const outside = page.items.filter((item) => item.id < oldestHead.id);
    return index === 0 ? { ...page, head: head.head, items: [...headItems, ...outside] } : { ...page, items: outside };
  });
  const merged = pages.flatMap((page) => page.items);
  const unchanged = merged.length === loaded.length && merged.every((item, index) => item === loaded[index]);
  if (!unchanged) return { pages, pageParams: data.pageParams };
  if (data.pages[0]?.head === head.head) return data;
  // 条目都没变、只有指纹不同（如本地已就地更新过）：只换指纹，下一轮 sync 不再重复探测
  return { ...data, pages: data.pages.map((page, index) => (index === 0 ? { ...page, head: head.head } : page)) };
}
