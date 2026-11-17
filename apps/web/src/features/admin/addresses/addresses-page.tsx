import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { measureElement as measureSize, useWindowVirtualizer } from '@tanstack/react-virtual';
import { ArrowRightLeft, AtSign, Mail, MoreHorizontal, Search, Share2, Trash2 } from 'lucide-react';
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, type NavigateFunction, useNavigate } from 'react-router-dom';
import type { Mailbox } from '@hpc-mail/shared';
import { invalidateMailboxOwnership } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useIsMobile } from '@/lib/use-media-query';
import { LoadMoreFooter } from '@/components/load-more-footer';
import { adminMailboxesQueryOptions } from './admin-mailboxes';
import { TransferMailboxDialog } from './transfer-mailbox-dialog';
import { AddressShareDialog } from './address-share-dialog';
import { useDebouncedValue } from '@/lib/use-debounced-value';

/** 搜索词停止输入这么久后才请求服务端 */
const SEARCH_DEBOUNCE_MS = 300;

function ForceReleaseDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [deleteHistory, setDeleteHistory] = useState(false);

  useEffect(() => {
    setDeleteHistory(false);
  }, [mailbox?.id]);

  const release = useMutation({
    mutationFn: (args: { id: number; deleteHistory: boolean }) =>
      mailboxApi.release(args.id, args.deleteHistory),
    onSuccess: (res) => {
      toast({
        title: res.deletedMessages
          ? `已强制释放，删除 ${res.deletedMessages} 封历史邮件`
          : '已强制释放',
        variant: 'success',
      });
      invalidateMailboxOwnership(queryClient);
      onClose();
    },
    meta: { errorTitle: '释放失败' },
  });

  return (
    <Dialog open={mailbox !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="强制释放地址" description={mailbox?.address} />
        <DialogBody>
          <div className="flex flex-col gap-3 text-sm text-ink-secondary">
            <p>
              该地址当前由 <b className="text-ink">{mailbox?.ownerUsername || '未知用户'}</b> 认领，强制释放后回到未认领态、可被任何人重新认领。
            </p>
            <p>若保留历史，下一个认领者可看到全部邮件。当前计数 {mailbox?.messageCount ?? 0}，可能有新来信。</p>
            {mailbox && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-critical"
                  checked={deleteHistory}
                  onChange={(event) => setDeleteHistory(event.target.checked)}
                />
                <span className="text-ink">同时永久删除该地址的全部历史邮件</span>
              </label>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={release.isPending}
            onClick={() => mailbox && release.mutate({ id: mailbox.id, deleteHistory })}
          >
            强制释放
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const mailPath = (mailbox: Mailbox) => `/admin/addresses/${mailbox.id}/mail`;

function AddressLink({ mailbox }: { mailbox: Mailbox }) {
  return (
    <Link to={mailPath(mailbox)} title={mailbox.address} className="truncate hover:text-accent hover:underline">
      {mailbox.address}
    </Link>
  );
}

interface RowActions {
  onTransfer: (mailbox: Mailbox) => void;
  onShare: (mailbox: Mailbox) => void;
  onRelease: (mailbox: Mailbox) => void;
  /** 共享弹窗关闭后把焦点还给触发它的按钮 */
  shareTrigger: RefObject<HTMLButtonElement | null>;
}

interface AddressListProps {
  mailboxes: Mailbox[];
  /** 还有未加载的页时总数未知（ARIA 约定为 -1） */
  total: number;
  actions: RowActions;
}

/**
 * 跟随窗口滚动的行虚拟化：只渲染视口附近的行，前后用占位撑出总高度。
 * 行留在正常文档流里，表格列与分隔线照常排版；行高逐行实测，按邮箱 id 缓存。
 */
function useWindowRows<T extends HTMLElement>(mailboxes: Mailbox[], estimateSize: number) {
  const listRef = useRef<T>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // 列表上方的布局（说明文字换行、字体就绪等）可能变化而没有 resize 事件：数据或过滤结果变化时也重测
  useLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      if (list) setScrollMargin(list.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [mailboxes]);

  // 行高按邮箱 id 缓存：搜索过滤后同一下标换了邮箱，不能沿用别的邮箱量出的高度
  const getItemKey = useCallback((index: number) => mailboxes[index]?.id ?? index, [mailboxes]);

  // 未渲染的行按最近实测的行高估算：行高随屏宽变化（如认领时间折行）时总高度也准，按 End 能直达底部
  const typicalSize = useRef(estimateSize);
  const virtualizer = useWindowVirtualizer({
    count: mailboxes.length,
    getItemKey,
    estimateSize: () => typicalSize.current,
    measureElement: (element, entry, instance) => {
      const size = measureSize(element, entry, instance);
      if (size > 0) typicalSize.current = size;
      return size;
    },
    overscan: 8,
    scrollMargin,
  });
  const rows = virtualizer.getVirtualItems();
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    listRef,
    rows,
    measureElement: virtualizer.measureElement,
    before: first ? first.start - scrollMargin : 0,
    after: last ? Math.max(0, virtualizer.getTotalSize() - (last.end - scrollMargin)) : 0,
  };
}

interface RowProps {
  mailbox: Mailbox;
  index: number;
  measureElement: (node: Element | null) => void;
  navigate: NavigateFunction;
  actions: RowActions;
}

const AddressTableRow = memo(function AddressTableRow({ mailbox, index, measureElement, navigate, actions }: RowProps) {
  return (
    <TableRow ref={measureElement} data-index={index} aria-rowindex={index + 2}>
      <TableCell className="truncate font-medium">
        <AddressLink mailbox={mailbox} />
      </TableCell>
      <TableCell className="truncate text-ink-secondary" title={mailbox.ownerUsername || undefined}>
        {mailbox.ownerUsername || '—'}
      </TableCell>
      <TableCell className="text-ink-secondary">{mailbox.messageCount}</TableCell>
      <TableCell className="text-ink-tertiary">{formatDateTime(mailbox.createdAt)}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <IconButton size="sm" aria-label={`查看邮件 ${mailbox.address}`} onClick={() => navigate(mailPath(mailbox))}>
            <Mail className="size-4" />
          </IconButton>
          <IconButton size="sm" aria-label={`过户 ${mailbox.address}`} onClick={() => actions.onTransfer(mailbox)}>
            <ArrowRightLeft className="size-4" />
          </IconButton>
          <IconButton
            size="sm"
            aria-label={`共享邮箱 ${mailbox.address}`}
            title="共享邮箱"
            onClick={(event) => {
              actions.shareTrigger.current = event.currentTarget;
              actions.onShare(mailbox);
            }}
          >
            <Share2 className="size-4" aria-hidden="true" />
          </IconButton>
          <IconButton size="sm" aria-label="强制释放" onClick={() => actions.onRelease(mailbox)}>
            <Trash2 className="size-4 text-critical" />
          </IconButton>
        </div>
      </TableCell>
    </TableRow>
  );
});

/** 占位行：撑出未渲染行的高度，对读屏隐藏 */
function SpacerRow({ height }: { height: number }) {
  return (
    <tr aria-hidden="true">
      <td colSpan={5} className="p-0" style={{ height }} />
    </tr>
  );
}

const AddressTable = memo(function AddressTable({ mailboxes, total, actions }: AddressListProps) {
  const navigate = useNavigate();
  const { listRef, rows, measureElement, before, after } = useWindowRows<HTMLTableSectionElement>(mailboxes, 57);
  return (
    // 只渲染部分行时列宽不能随可见内容跳动：固定表格布局，地址列占剩余宽度，超长截断并用 title 显示全文
    <Table className="table-fixed" aria-rowcount={total < 0 ? -1 : total + 1}>
      <colgroup>
        <col />
        <col className="w-[15%]" />
        <col className="w-[10%]" />
        <col className="w-[20%]" />
        <col className="w-44" />
      </colgroup>
      <TableHeader>
        <TableRow aria-rowindex={1}>
          <TableHead>地址</TableHead>
          <TableHead>归属用户</TableHead>
          <TableHead>邮件数</TableHead>
          <TableHead>认领时间</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody ref={listRef}>
        {before > 0 && <SpacerRow height={before} />}
        {rows.map((row) => {
          const mailbox = mailboxes[row.index];
          if (!mailbox) return null;
          return (
            <AddressTableRow
              key={mailbox.id}
              mailbox={mailbox}
              index={row.index}
              measureElement={measureElement}
              navigate={navigate}
              actions={actions}
            />
          );
        })}
        {after > 0 && <SpacerRow height={after} />}
      </TableBody>
    </Table>
  );
});

const AddressCard = memo(function AddressCard({
  mailbox,
  index,
  total,
  measureElement,
  navigate,
  actions,
}: RowProps & { total: number }) {
  return (
    <CardListItem
      ref={measureElement}
      data-index={index}
      aria-posinset={index + 1}
      aria-setsize={total}
      title={<AddressLink mailbox={mailbox} />}
      subtitle={`归属 ${mailbox.ownerUsername || '—'}`}
      meta={
        <>
          <span>{mailbox.messageCount} 封邮件</span>
          <span>{formatDateTime(mailbox.createdAt)} 认领</span>
        </>
      }
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" aria-label="更多操作" onFocus={(event) => { actions.shareTrigger.current = event.currentTarget; }}>
              <MoreHorizontal className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          {/* Radix 只在菜单打开时挂载内容，每张卡片常驻的只有触发按钮 */}
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => navigate(mailPath(mailbox))}>
              <Mail className="size-4 text-ink-tertiary" />
              查看邮件
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onTransfer(mailbox)}>
              <ArrowRightLeft className="size-4 text-ink-tertiary" />
              过户给其他用户
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.onShare(mailbox)}>
              <Share2 className="size-4 text-ink-tertiary" aria-hidden="true" />
              共享邮箱
            </DropdownMenuItem>
            <DropdownMenuItem tone="danger" onSelect={() => actions.onRelease(mailbox)}>
              <Trash2 className="size-4" />
              强制释放
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
});

const AddressCards = memo(function AddressCards({ mailboxes, total, actions }: AddressListProps) {
  const navigate = useNavigate();
  const { listRef, rows, measureElement, before, after } = useWindowRows<HTMLUListElement>(mailboxes, 90);
  return (
    <CardList ref={listRef}>
      {before > 0 && <li aria-hidden="true" style={{ height: before }} />}
      {rows.map((row) => {
        const mailbox = mailboxes[row.index];
        if (!mailbox) return null;
        return (
          <AddressCard
            key={mailbox.id}
            mailbox={mailbox}
            index={row.index}
            total={total}
            measureElement={measureElement}
            navigate={navigate}
            actions={actions}
          />
        );
      })}
      {after > 0 && <li aria-hidden="true" style={{ height: after }} />}
    </CardList>
  );
});

export function AddressesPage() {
  const isMobile = useIsMobile();
  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q.trim().toLowerCase(), SEARCH_DEBOUNCE_MS);
  const {
    data, isLoading, isError, error, refetch, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage,
  } = useInfiniteQuery({
    ...adminMailboxesQueryOptions({ q: debouncedQ || undefined }),
    // 换搜索词时先保留上一次的结果，新结果到达后再替换，不闪回骨架屏
    placeholderData: (previous) => previous,
  });
  const mailboxes = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const [releasing, setReleasing] = useState<Mailbox | null>(null);
  const [transferring, setTransferring] = useState<Mailbox | null>(null);
  const [sharing, setSharing] = useState<Mailbox | null>(null);
  const shareTrigger = useRef<HTMLButtonElement | null>(null);

  const closeSharing = useCallback(() => {
    setSharing(null);
    requestAnimationFrame(() => shareTrigger.current?.focus());
  }, []);

  // 引用保持稳定：输入搜索词、打开弹窗时列表与各行不必重渲染
  const actions = useMemo<RowActions>(
    () => ({ onTransfer: setTransferring, onShare: setSharing, onRelease: setReleasing, shareTrigger }),
    [],
  );
  const total = hasNextPage ? -1 : mailboxes.length;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="全站地址" description="查看所有已认领地址及其收发件，管理共享、过户或强制释放。" />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索地址或用户名" maxLength={254} className="pl-9" />
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError && mailboxes.length === 0 ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : mailboxes.length === 0 ? (
        <EmptyState
          icon={AtSign}
          title={debouncedQ ? '没有匹配的地址' : '还没有任何认领地址'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <>
          {isMobile ? (
            <AddressCards mailboxes={mailboxes} total={total} actions={actions} />
          ) : (
            <AddressTable mailboxes={mailboxes} total={total} actions={actions} />
          )}
          {isError ? (
            <QueryErrorState error={error} onRetry={() => void (isFetchNextPageError ? fetchNextPage() : refetch())} />
          ) : (
            <LoadMoreFooter hasNextPage={hasNextPage} isFetchingNextPage={isFetchingNextPage} onLoadMore={loadMore} />
          )}
        </>
      )}

      <ForceReleaseDialog mailbox={releasing} onClose={() => setReleasing(null)} />
      <TransferMailboxDialog mailbox={transferring} onClose={() => setTransferring(null)} />
      {sharing && <AddressShareDialog key={sharing.id} mailbox={sharing} onClose={closeSharing} />}
    </div>
  );
}
