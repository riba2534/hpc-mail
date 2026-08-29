import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, Inbox as InboxIcon, MailOpen, RotateCcw, SearchX, Star, Trash2, X } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type { MessageSummary } from '@hpc-mail/shared';
import { mailHref } from './mail-view';
import { MessageRow } from './message-row';
import { useMessagesQuery } from './use-messages';
import { useStarMutation } from './use-star';

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

export function MailList({
  query,
  hasActiveFilters = false,
  onClearFilters,
  emptyTitle,
  emptyDescription,
  variant = 'inbox',
  readOnly = false,
}: MailListProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useMessagesQuery(query);
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  const starView =
    query.scope === 'unclaimed' || query.scope === 'user'
      ? { scope: query.scope, userId: query.userId }
      : undefined;
  const star = useStarMutation(starView);
  const handleToggleStar = (message: MessageSummary) =>
    star.mutate({ id: message.id, starred: !message.isStarred });

  // ---- 批量选择 ----
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const lastClickedRef = useRef<number | null>(null);
  const loadedIds = useMemo(() => items.map((m) => m.id), [items]);

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
    [loadedIds],
  );

  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));

  const invalidateMessages = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
  };

  // 未认领视图的批量已读/删除必须显式带 scope，否则后端只动自己认领的地址
  const mutationScope = query.scope === 'unclaimed' ? ('unclaimed' as const) : undefined;

  const batchRead = useMutation({
    mutationFn: ({ ids, isRead }: { ids: number[]; isRead: boolean }) =>
      messageApi.markRead(ids, isRead, mutationScope),
    onSuccess: (_d, { isRead }) => {
      toast({ title: isRead ? '已标记为已读' : '已标记为未读', variant: 'success' });
      clearSelection();
      invalidateMessages();
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const batchStar = useMutation({
    mutationFn: (ids: number[]) => messageApi.star(ids, true, starView),
    onSuccess: () => {
      toast({ title: '已加星标', variant: 'success' });
      clearSelection();
      invalidateMessages();
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const batchDelete = useMutation({
    mutationFn: (ids: number[]) => messageApi.remove(ids, mutationScope),
    onSuccess: (_d, ids) => {
      toast({ title: `已删除 ${ids.length} 封`, variant: 'success' });
      clearSelection();
      invalidateMessages();
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const batchRestore = useMutation({
    mutationFn: (ids: number[]) => messageApi.restore(ids, mutationScope),
    onSuccess: (_d, ids) => {
      toast({ title: `已恢复 ${ids.length} 封`, variant: 'success' });
      clearSelection();
      invalidateMessages();
    },
    onError: () => toast({ title: '恢复失败，请重试', variant: 'error' }),
  });

  const batchPurge = useMutation({
    mutationFn: (ids: number[]) => messageApi.purge(ids, mutationScope),
    onSuccess: (_d, ids) => {
      toast({ title: `已永久删除 ${ids.length} 封`, variant: 'success' });
      clearSelection();
      invalidateMessages();
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

  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= items.length - 1 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
        </div>
      )}
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
                  onClick={() => batchPurge.mutate(selectedIds)}
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
                  onClick={() => batchDelete.mutate(selectedIds)}
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
    </div>
  );
}
