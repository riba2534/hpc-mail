import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  Check,
  Inbox as InboxIcon,
  ListChecks,
  Mail,
  MailOpen,
  Minus,
  RefreshCw,
  RotateCcw,
  SearchX,
  Star,
  StarOff,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { type FocusEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ListMessagesQuery, MessageSummary } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { loadMessagePage, warmModule } from '@/app/route-modules';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { listMailView, mailHref } from './mail-view';
import { syncReadState, syncRemovedMessages, syncStarState } from './message-cache';
import { messageDetailQueryOptions } from './message-queries';
import { MessageRow, type RowCheckbox } from './message-row';
import { useDeleteMessages } from './use-delete-messages';
import { useMailShortcuts } from './use-mail-shortcuts';
import { useMessagesQuery } from './use-messages';
import { useStarMutation } from './use-star';

/** 距已加载末尾不足这么多行就开始拉下一页（用户已开始滚动时） */
const PREFETCH_ROWS = 20;
/** 悬停/聚焦行这么久才预取详情，划过不算 */
const DETAIL_PREFETCH_DELAY_MS = 100;

const SHARED_READ_ONLY = '共享给你的邮件只读，不能改变已读状态';

/** 列表行链接带给详情页的上下文：详情页据此从同一列表缓存取上一封/下一封 */
export interface MailListLinkState {
  list: Partial<ListMessagesQuery>;
}

export interface MailListProps {
  query: Partial<ListMessagesQuery>;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  /** 筛选无结果时列出叠加了哪些条件，如「域名 a.com」「仅未读」 */
  activeFilterLabels?: string[];
  emptyTitle: string;
  emptyDescription?: string;
  /** trash 模式：批量工具栏改为恢复/永久删除 */
  variant?: 'inbox' | 'trash';
  /** 审计他人已认领邮件：可看、可星标，不能标已读/删除 */
  readOnly?: boolean;
  /** 列表为空时替代默认空态（含筛选无结果） */
  emptyContent?: ReactNode;
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex gap-3 px-4 py-3.5">
          <Skeleton className="mt-1 size-2 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-full max-w-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 分钟级时钟：memo 行据此刷新「n 分钟前」 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  return now;
}

/** 空闲时预取详情页 chunk，点开第一封邮件不再等 chunk */
function useIdleWarm(load: () => Promise<unknown>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof globalThis.requestIdleCallback === 'function') {
      const handle = globalThis.requestIdleCallback(() => warmModule(load), { timeout: 3_000 });
      return () => globalThis.cancelIdleCallback(handle);
    }
    const timer = globalThis.setTimeout(() => warmModule(load), 1_500);
    return () => globalThis.clearTimeout(timer);
  }, [load, enabled]);
}

/** 批量工具栏按钮：小屏只留图标，名称由 aria-label/title 提供 */
function BatchButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="px-2 md:px-3"
    >
      <Icon className={cn('size-4', danger && 'text-critical')} />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

export function MailList({
  query,
  hasActiveFilters = false,
  onClearFilters,
  activeFilterLabels,
  emptyTitle,
  emptyDescription,
  variant = 'inbox',
  readOnly = false,
  emptyContent,
}: MailListProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMessagesQuery(query);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const now = useMinuteClock();
  useIdleWarm(loadMessagePage, items.length > 0);
  // 触屏等不能悬停的设备：不渲染悬停才出现的复选框，改由「选择」进入多选
  const noHover = useMediaQuery('(hover: none)');
  const trash = variant === 'trash';

  // 「共享来的」= 个人视图里地址不在自己认领列表中：只读，不改已读状态、不能删除
  const { data: ownedMailboxes } = useMailboxesQuery(false);
  const personalView = (query.scope ?? 'mine') === 'mine';
  const ownedAddresses = useMemo(
    () => (ownedMailboxes ? new Set(ownedMailboxes.map((mailbox) => mailbox.address)) : null),
    [ownedMailboxes],
  );
  const isShared = useCallback(
    (message: MessageSummary) => personalView && ownedAddresses !== null && !ownedAddresses.has(message.address),
    [personalView, ownedAddresses],
  );

  // 调用方常传字面量：按内容稳定引用，行链接 state 不因父组件重渲染而变化
  const queryIdentity = JSON.stringify(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableQuery = useMemo(() => query, [queryIdentity]);
  const linkState = useMemo<MailListLinkState>(() => ({ list: stableQuery }), [stableQuery]);

  // 与行链接 /mail/:id?scope=… 解析出的上下文一致：星标与详情预取都写入详情页会读取的 queryKey
  const mailView = useMemo(
    () => listMailView({ scope: query.scope, userId: query.userId }),
    [query.scope, query.userId],
  );
  const { mutate: toggleStar } = useStarMutation(mailView);
  const handleToggleStar = useCallback(
    (message: MessageSummary) => toggleStar({ id: message.id, starred: !message.isStarred }),
    [toggleStar],
  );

  // ---- 悬停/聚焦行时预取详情（GET 无副作用；已读由详情页单独 POST）----
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleOpenIntent = useCallback(
    (id: number | null) => {
      globalThis.clearTimeout(prefetchTimer.current);
      if (id === null) return;
      prefetchTimer.current = globalThis.setTimeout(() => {
        void queryClient.prefetchQuery(messageDetailQueryOptions(id, mailView));
      }, DETAIL_PREFETCH_DELAY_MS);
    },
    [queryClient, mailView],
  );
  useEffect(() => () => globalThis.clearTimeout(prefetchTimer.current), []);

  // ---- 批量选择 ----
  const [selection, setSelection] = useState<Set<number>>(new Set());
  /** 触屏设备的多选模式（没有悬停，复选框改由「选择」按钮进入） */
  const [selectionMode, setSelectionMode] = useState(false);
  const [purgeIds, setPurgeIds] = useState<number[]>([]);
  const lastClickedRef = useRef<number | null>(null);
  const loadedIds = useMemo(() => items.map((m) => m.id), [items]);
  // 连选读最新 id 序列，回调本身保持稳定，新邮件到达不会让所有 memo 行重渲染
  const loadedIdsRef = useRef(loadedIds);
  loadedIdsRef.current = loadedIds;

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setSelectionMode(false);
    lastClickedRef.current = null;
  }, []);

  // 切换筛选条件时清空选择，避免残留已不在列表中的 id
  useEffect(() => {
    clearSelection();
  }, [queryIdentity, clearSelection]);

  const toggleSelect = useCallback(
    (id: number, event: MouseEvent | { shiftKey: boolean }) => {
      const loadedIds = loadedIdsRef.current;
      setSelection((prev) => {
        const next = new Set(prev);
        // Shift 连选：选中上次点击到本次之间的所有行
        if (event.shiftKey && lastClickedRef.current !== null) {
          const a = loadedIds.indexOf(lastClickedRef.current);
          const b = loadedIds.indexOf(id);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) next.add(loadedIds[i]!);
            lastClickedRef.current = id;
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        lastClickedRef.current = id;
        return next;
      });
    },
    [],
  );

  const selectionActive = selection.size > 0;
  const selectedIds = useMemo(() => [...selection], [selection]);
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
  const selectable = !readOnly;

  // 未认领视图的批量已读/删除必须显式带 scope，否则后端只动自己认领的地址
  const mutationScope = query.scope === 'unclaimed' ? ('unclaimed' as const) : undefined;

  // 批量操作先按 id 就地更新缓存；服务端实际生效数与按本地状态预期的不一致时
  // （部分无权限、或已在别处改变），就地结果不可信，退回整表重拉对齐
  const itemById = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const reconcileLists = (applied: number, expected: number) => {
    if (applied !== expected) void queryClient.invalidateQueries({ queryKey: queryKeys.messages.lists });
  };
  const ownIds = (ids: number[]) => ids.filter((id) => {
    const message = itemById.get(id);
    return message ? !isShared(message) : false;
  });

  const batchRead = useMutation({
    mutationFn: ({ ids, isRead }: { ids: number[]; isRead: boolean; skipped: number }) =>
      messageApi.markRead(ids, isRead, mutationScope),
    onSuccess: ({ changed }, { ids, isRead, skipped }) => {
      const skippedNote = skipped > 0 ? `，跳过 ${skipped} 封共享邮件` : '';
      toast({ title: changed ? `已将 ${changed} 封标记为${isRead ? '已读' : '未读'}${skippedNote}` : `没有邮件状态改变${skippedNote}`, variant: 'success' });
      clearSelection();
      const expected = ids.filter((id) => itemById.get(id)?.isRead !== isRead).length;
      syncReadState(queryClient, ids, isRead);
      reconcileLists(changed, expected);
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const markRead = (ids: number[], isRead: boolean) => {
    const writable = ownIds(ids);
    if (writable.length === 0) {
      toast({ title: SHARED_READ_ONLY, variant: 'error' });
      return;
    }
    batchRead.mutate({ ids: writable, isRead, skipped: ids.length - writable.length });
  };

  const batchStar = useMutation({
    mutationFn: ({ ids, starred }: { ids: number[]; starred: boolean }) => messageApi.star(ids, starred, mailView),
    onSuccess: ({ changed }, { ids, starred }) => {
      toast({ title: changed ? `已为 ${changed} 封${starred ? '加星标' : '取消星标'}` : '没有邮件状态改变', variant: 'success' });
      clearSelection();
      const expected = ids.filter((id) => itemById.get(id)?.isStarred !== starred).length;
      syncStarState(queryClient, ids, starred);
      reconcileLists(changed, expected);
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const batchDelete = useDeleteMessages(mutationScope, clearSelection);
  const removeMessages = (ids: number[]) => {
    const deletable = ownIds(ids);
    if (deletable.length === 0) {
      toast({ title: '共享邮箱里的邮件不能删除', variant: 'error' });
      return;
    }
    batchDelete.mutate(deletable);
  };

  const batchRestore = useMutation({
    mutationFn: (ids: number[]) => messageApi.restore(ids, mutationScope),
    onSuccess: ({ changed }, ids) => {
      toast({ title: changed ? `已恢复 ${changed} 封` : '没有可恢复的邮件', variant: 'success' });
      clearSelection();
      syncRemovedMessages(queryClient, ids, 'trash');
      reconcileLists(changed, ids.length);
    },
    onError: () => toast({ title: '恢复失败，请重试', variant: 'error' }),
  });

  const batchPurge = useMutation({
    mutationFn: (ids: number[]) => messageApi.purge(ids, mutationScope),
    onSuccess: ({ changed }, ids) => {
      toast({ title: changed ? `已永久删除 ${changed} 封` : '没有可永久删除的邮件', variant: 'success' });
      setPurgeIds([]);
      clearSelection();
      syncRemovedMessages(queryClient, ids, 'trash');
      reconcileLists(changed, ids.length);
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const batchPending =
    batchRead.isPending ||
    batchStar.isPending ||
    batchDelete.isPending ||
    batchRestore.isPending ||
    batchPurge.isPending;
  const selectedOwnCount = useMemo(
    () => selectedIds.filter((id) => {
      const message = itemById.get(id);
      return message ? !isShared(message) : false;
    }).length,
    [selectedIds, itemById, isShared],
  );

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, [items.length]);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => 84,
    overscan: 8,
    scrollMargin,
  });
  const virtualItems = virtualizer.getVirtualItems();

  const scrolled = (virtualizer.scrollOffset ?? 0) > 0;
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last || !hasNextPage || isFetchingNextPage) return;
    // 首屏只在内容不足一屏时续页；开始滚动后提前约 20 行续页，滚到底前下一页已就绪
    const threshold = scrolled ? PREFETCH_ROWS : 0;
    if (last.index >= items.length - 1 - threshold) void fetchNextPage();
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, fetchNextPage, scrolled]);

  // ---- 键盘：j/k 移动焦点行，o/Enter 打开，x 选中，s 星标，e/# 删除，Shift+I/U 已读/未读（/ 由全局处理）----
  const cursorRef = useRef<number | null>(null);
  const handleListFocus = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-message-id]');
    if (row) cursorRef.current = Number(row.dataset.messageId);
  };
  const cursorIndex = () => (cursorRef.current === null ? -1 : loadedIds.indexOf(cursorRef.current));
  const focusRow = (index: number) => {
    const id = loadedIds[index];
    if (id === undefined) return;
    cursorRef.current = id;
    const tryFocus = (attempt: number) => {
      const link = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"] [data-row-link]`);
      if (link) {
        link.focus();
        return;
      }
      if (attempt === 0) virtualizer.scrollToIndex(index, { align: 'center' });
      if (attempt < 5) globalThis.requestAnimationFrame(() => tryFocus(attempt + 1));
    };
    tryFocus(0);
  };
  const cursorMessage = () => {
    const index = cursorIndex();
    return index === -1 ? undefined : items[index];
  };
  /** 批量快捷键作用于已选；没有选择时作用于焦点行 */
  const shortcutTargets = () => {
    if (selectionActive) return selectedIds;
    const message = cursorMessage();
    return message ? [message.id] : [];
  };
  const openMessage = (message: MessageSummary) => navigate(mailHref(message.id, query), { state: linkState });

  useMailShortcuts({
    j: () => {
      if (cursorIndex() >= items.length - 1 && hasNextPage) void fetchNextPage();
      focusRow(Math.min(cursorIndex() + 1, items.length - 1));
    },
    k: () => focusRow(Math.max(cursorIndex() - 1, 0)),
    o: () => {
      const message = cursorMessage();
      if (message) openMessage(message);
    },
    Enter: (event) => {
      // 焦点在链接或按钮上时交给浏览器原生激活
      if ((event.target as HTMLElement | null)?.closest?.('a,button')) return false;
      const message = cursorMessage();
      if (!message) return false;
      openMessage(message);
    },
    x: () => {
      const message = cursorMessage();
      if (message && selectable) toggleSelect(message.id, { shiftKey: false });
    },
    s: () => {
      const message = cursorMessage();
      if (message && !trash) handleToggleStar(message);
    },
    e: () => deleteShortcut(),
    '#': () => deleteShortcut(),
    'Shift+I': () => readShortcut(true),
    'Shift+U': () => readShortcut(false),
  });
  function deleteShortcut() {
    const ids = shortcutTargets();
    if (!selectable || ids.length === 0 || batchPending) return;
    if (trash) setPurgeIds(ids);
    else removeMessages(ids);
  }
  function readShortcut(isRead: boolean) {
    const ids = shortcutTargets();
    if (!selectable || trash || ids.length === 0 || batchPending) return;
    markRead(ids, isRead);
  }

  if (isLoading) return <ListSkeleton />;

  if (isError && items.length === 0) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="加载失败"
        description={error instanceof Error ? error.message : '网络异常，请重试'}
        action={
          <Button variant="secondary" onClick={() => refetch()}>
            重试
          </Button>
        }
        className="rounded-lg border border-line bg-surface"
      />
    );
  }

  if (items.length === 0) {
    if (emptyContent) return <>{emptyContent}</>;
    return hasActiveFilters ? (
      <EmptyState
        icon={SearchX}
        title="没有匹配的邮件"
        description={
          activeFilterLabels?.length
            ? `当前叠加了 ${activeFilterLabels.join('、')}。试试放宽或清除筛选。`
            : '试试调整筛选条件或清除筛选。'
        }
        action={
          onClearFilters && (
            <Button variant="secondary" onClick={onClearFilters}>
              清除筛选
            </Button>
          )
        }
        className="rounded-lg border border-line bg-surface"
      />
    ) : (
      <EmptyState
        icon={InboxIcon}
        title={emptyTitle}
        description={emptyDescription}
        className="rounded-lg border border-line bg-surface"
      />
    );
  }

  const checkbox: RowCheckbox = noHover
    ? selectionMode || selectionActive ? 'always' : 'hidden'
    : selectionActive ? 'always' : 'hover';
  const tapToSelect = noHover && (selectionMode || selectionActive);
  const someSelected = selectionActive && !allSelected;

  return (
    <div className="flex flex-col gap-2">
      {isError && (
        <div className="flex items-center gap-2 rounded-md border border-caution-soft bg-caution-soft px-3 py-2 text-sm text-caution">
          <AlertCircle className="size-4 shrink-0" />
          网络异常，显示的是缓存内容。
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>重新加载</Button>
        </div>
      )}
      {/* 常驻工具行：高度固定，选中前后原地切换内容，列表不跳动 */}
      <div className="sticky top-14 z-20 flex h-11 items-center gap-2 bg-canvas">
        {selectable && !noHover && (
          <button
            type="button"
            role="checkbox"
            aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
            aria-label={allSelected ? '取消全选' : `全选已加载（${loadedIds.length} 封）`}
            title={allSelected ? '取消全选' : `全选已加载（${loadedIds.length} 封）`}
            onClick={() => (allSelected ? clearSelection() : setSelection(new Set(loadedIds)))}
            className={cn(
              'ml-3 grid size-5 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              allSelected || someSelected
                ? 'border-accent bg-accent text-on-accent'
                : 'border-line-strong bg-surface text-transparent hover:border-accent',
            )}
          >
            {someSelected ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
          </button>
        )}
        {selectable && noHover && !selectionActive && (
          selectionMode ? (
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              <X className="size-4" />
              取消
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setSelectionMode(true)}>
              <ListChecks className="size-4" />
              选择
            </Button>
          )
        )}
        {selectionActive ? (
          <>
            <span className="shrink-0 text-sm text-ink-secondary">已选 {selection.size} 封</span>
            {!allSelected && (
              <button
                type="button"
                className="hidden shrink-0 text-sm font-medium text-accent hover:underline sm:inline"
                onClick={() => setSelection(new Set(loadedIds))}
              >
                全选已加载（{loadedIds.length}）
              </button>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-0.5">
              {trash ? (
                <>
                  <BatchButton icon={RotateCcw} label="恢复" disabled={batchPending} onClick={() => batchRestore.mutate(selectedIds)} />
                  <BatchButton icon={Trash2} label="永久删除" danger disabled={batchPending} onClick={() => setPurgeIds(selectedIds)} />
                </>
              ) : (
                <>
                  <BatchButton
                    icon={MailOpen}
                    label="标为已读"
                    disabled={batchPending || selectedOwnCount === 0}
                    title={selectedOwnCount === 0 ? SHARED_READ_ONLY : undefined}
                    onClick={() => markRead(selectedIds, true)}
                  />
                  <BatchButton
                    icon={Mail}
                    label="标为未读"
                    disabled={batchPending || selectedOwnCount === 0}
                    title={selectedOwnCount === 0 ? SHARED_READ_ONLY : undefined}
                    onClick={() => markRead(selectedIds, false)}
                  />
                  <BatchButton icon={Star} label="加星标" disabled={batchPending} onClick={() => batchStar.mutate({ ids: selectedIds, starred: true })} />
                  <BatchButton icon={StarOff} label="取消星标" disabled={batchPending} onClick={() => batchStar.mutate({ ids: selectedIds, starred: false })} />
                  <BatchButton icon={Trash2} label="删除" danger disabled={batchPending} onClick={() => removeMessages(selectedIds)} />
                </>
              )}
              <IconButton size="sm" aria-label="取消选择" onClick={clearSelection}>
                <X className="size-4" />
              </IconButton>
            </div>
          </>
        ) : (
          <>
            {selectionMode && <span className="text-sm text-ink-tertiary">点按邮件以选择</span>}
            <IconButton size="sm" className="ml-auto" aria-label="刷新邮件" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            </IconButton>
          </>
        )}
      </div>
      {selectionActive && selectedOwnCount < selection.size && !trash && personalView && (
        <p className="-mt-1 px-1 text-xs text-ink-tertiary">
          已选中 {selection.size - selectedOwnCount} 封共享邮件：只读，不能改变已读状态或删除。
        </p>
      )}
      <div
        ref={listRef}
        onFocus={handleListFocus}
        className="relative overflow-hidden rounded-lg border border-line bg-surface"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualItem) => {
          const message = items[virtualItem.index];
          if (!message) return null;
          return (
            <div
              key={message.id}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
            >
              <MessageRow
                message={message}
                href={mailHref(message.id, query)}
                linkState={linkState}
                onToggleStar={handleToggleStar}
                selected={selection.has(message.id)}
                checkbox={checkbox}
                tapToSelect={tapToSelect}
                onToggleSelect={selectable ? toggleSelect : undefined}
                shared={isShared(message)}
                trash={trash}
                now={now}
                onOpenIntent={handleOpenIntent}
              />
            </div>
          );
        })}
      </div>
      {isFetchingNextPage && (
        <div className="flex justify-center py-2">
          <Spinner className="size-5 text-ink-tertiary" />
        </div>
      )}
      <ConfirmDialog
        open={purgeIds.length > 0}
        onOpenChange={(next) => !next && setPurgeIds([])}
        title={`永久删除 ${purgeIds.length} 封邮件？`}
        description="邮件正文、原始邮件和附件会被永久删除，此操作无法撤销。"
        confirmLabel={`永久删除 ${purgeIds.length} 封`}
        tone="danger"
        loading={batchPurge.isPending}
        onConfirm={() => batchPurge.mutate(purgeIds)}
      />
    </div>
  );
}
