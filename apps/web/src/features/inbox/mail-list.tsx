import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Inbox as InboxIcon, MailOpen, RotateCcw, SearchX, Star, Trash2, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { loadMessagePage, warmModule } from '@/app/route-modules';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type { MessageSummary } from '@hpc-mail/shared';
import { useSharedMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { listMailView, mailHref } from './mail-view';
import { syncReadState, syncRemovedMessages, syncStarState } from './message-cache';
import { messageDetailQueryOptions } from './message-queries';
import { MessageRow } from './message-row';
import { useMessagesQuery } from './use-messages';
import { useStarMutation } from './use-star';

/** 距已加载末尾不足这么多行就开始拉下一页（用户已开始滚动时） */
const PREFETCH_ROWS = 20;
/** 悬停/聚焦行这么久才预取详情，划过不算 */
const DETAIL_PREFETCH_DELAY_MS = 100;

export interface MailListProps {
  query: Partial<ListMessagesQuery>;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
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

export function MailList({
  query,
  hasActiveFilters = false,
  onClearFilters,
  emptyTitle,
  emptyDescription,
  variant = 'inbox',
  readOnly = false,
  emptyContent,
}: MailListProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMessagesQuery(query);
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const now = useMinuteClock();
  useIdleWarm(loadMessagePage, items.length > 0);
  const { data: sharedMailboxes } = useSharedMailboxesQuery();
  const sharedAddresses = useMemo(
    () => new Set((sharedMailboxes ?? []).map((mailbox) => mailbox.address)),
    [sharedMailboxes],
  );

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
  const [purgeIds, setPurgeIds] = useState<number[]>([]);
  const lastClickedRef = useRef<number | null>(null);
  const loadedIds = useMemo(() => items.map((m) => m.id), [items]);
  // 连选读最新 id 序列，回调本身保持稳定，新邮件到达不会让所有 memo 行重渲染
  const loadedIdsRef = useRef(loadedIds);
  loadedIdsRef.current = loadedIds;

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    lastClickedRef.current = null;
  }, []);

  // 切换筛选条件时清空选择，避免残留已不在列表中的 id
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    clearSelection();
  }, [queryKey, clearSelection]);

  const toggleSelect = useCallback(
    (id: number, event: MouseEvent) => {
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

  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));

  // 未认领视图的批量已读/删除必须显式带 scope，否则后端只动自己认领的地址
  const mutationScope = query.scope === 'unclaimed' ? ('unclaimed' as const) : undefined;

  // 批量操作先按 id 就地更新缓存；服务端实际生效数与按本地状态预期的不一致时
  // （部分无权限、或已在别处改变），就地结果不可信，退回整表重拉对齐
  const itemById = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const reconcileLists = (applied: number, expected: number) => {
    if (applied !== expected) void queryClient.invalidateQueries({ queryKey: queryKeys.messages.lists });
  };

  const batchRead = useMutation({
    mutationFn: ({ ids, isRead }: { ids: number[]; isRead: boolean }) =>
      messageApi.markRead(ids, isRead, mutationScope),
    onSuccess: ({ changed }, { ids, isRead }) => {
      toast({ title: changed ? `已将 ${changed} 封标记为${isRead ? '已读' : '未读'}` : '没有邮件状态改变', variant: 'success' });
      clearSelection();
      const expected = ids.filter((id) => itemById.get(id)?.isRead !== isRead).length;
      syncReadState(queryClient, ids, isRead);
      reconcileLists(changed, expected);
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const batchStar = useMutation({
    mutationFn: (ids: number[]) => messageApi.star(ids, true, mailView),
    onSuccess: ({ changed }, ids) => {
      toast({ title: changed ? `已为 ${changed} 封加星标` : '没有邮件状态改变', variant: 'success' });
      clearSelection();
      const expected = ids.filter((id) => !itemById.get(id)?.isStarred).length;
      syncStarState(queryClient, ids, true);
      reconcileLists(changed, expected);
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const batchDelete = useMutation({
    mutationFn: (ids: number[]) => messageApi.remove(ids, mutationScope),
    onSuccess: (result, ids) => {
      if (result.deleted === 0) {
        toast({ title: '这些邮件不能删除', variant: 'error' });
        return;
      }
      toast({ title: `已删除 ${result.deleted} 封`, variant: 'success' });
      clearSelection();
      syncRemovedMessages(queryClient, ids, 'live');
      reconcileLists(result.deleted, ids.length);
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

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

  const selectionActive = selection.size > 0;
  const selectedIds = useMemo(() => [...selection], [selection]);
  const batchPending =
    batchRead.isPending ||
    batchStar.isPending ||
    batchDelete.isPending ||
    batchRestore.isPending ||
    batchPurge.isPending;

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
        description="试试调整筛选条件或清除筛选。"
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

  return (
    <div className="flex flex-col gap-3">
      {isError && (
        <div className="flex items-center gap-2 rounded-md border border-caution-soft bg-caution-soft px-3 py-2 text-sm text-caution">
          <AlertCircle className="size-4 shrink-0" />
          网络异常，显示的是缓存内容。
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>重新加载</Button>
        </div>
      )}
      <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => void refetch()}>刷新邮件</Button></div>
      {selectionActive && (
        <div className="sticky top-14 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 shadow-sm">
          <button
            type="button"
            className="text-sm font-medium text-accent hover:underline"
            onClick={() =>
              allSelected ? clearSelection() : setSelection(new Set(loadedIds))
            }
          >
            {allSelected ? '取消全选' : `全选本页（${loadedIds.length}）`}
          </button>
          <span className="text-sm text-ink-secondary">已选 {selection.size} 封</span>
          <div className="ml-auto flex items-center gap-1">
            {variant === 'trash' ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchPending}
                  onClick={() => batchRestore.mutate(selectedIds)}
                >
                  <RotateCcw className="size-4" />
                  恢复
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchPending}
                  onClick={() => setPurgeIds(selectedIds)}
                >
                  <Trash2 className="size-4 text-critical" />
                  永久删除
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchPending}
                  onClick={() => batchRead.mutate({ ids: selectedIds, isRead: true })}
                >
                  <MailOpen className="size-4" />
                  已读
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchPending}
                  onClick={() => batchStar.mutate(selectedIds)}
                >
                  <Star className="size-4" />
                  星标
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={batchPending}
                  onClick={() => {
                    const deletable = selectedIds.filter((id) => {
                      const message = items.find((item) => item.id === id);
                      return message ? !sharedAddresses.has(message.address) : false;
                    });
                    if (deletable.length === 0) {
                      toast({ title: '共享邮箱里的邮件不能删除', variant: 'error' });
                      return;
                    }
                    batchDelete.mutate(deletable);
                  }}
                >
                  <Trash2 className="size-4 text-critical" />
                  删除
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={clearSelection} aria-label="取消选择">
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
      <div
        ref={listRef}
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
                onToggleStar={handleToggleStar}
                selected={selection.has(message.id)}
                selectionActive={selectionActive}
                onToggleSelect={readOnly ? undefined : toggleSelect}
                shared={sharedAddresses.has(message.address)}
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
