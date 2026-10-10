import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, AtSign, MoreHorizontal, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { TransferMailboxDialog } from './transfer-mailbox-dialog';

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
    onError: () => toast({ title: '释放失败，请重试', variant: 'error' }),
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

export function AddressesPage() {
  const isMobile = useIsMobile();
  const { data: mailboxes, isLoading, isError, error, refetch } = useMailboxesQuery(true);
  const [q, setQ] = useState('');
  const [releasing, setReleasing] = useState<Mailbox | null>(null);
  const [transferring, setTransferring] = useState<Mailbox | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = mailboxes ?? [];
    if (!term) return list;
    return list.filter(
      (m) => m.address.includes(term) || (m.ownerUsername ?? '').toLowerCase().includes(term),
    );
  }, [mailboxes, q]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="全站地址" description="查看所有已认领地址，可过户给指定用户或强制释放。" />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索地址或用户名" className="pl-9" />
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={AtSign}
          title={q ? '没有匹配的地址' : '还没有任何认领地址'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {filtered.map((mailbox) => (
            <CardListItem
              key={mailbox.id}
              title={<span className="truncate">{mailbox.address}</span>}
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
                    <IconButton size="sm" aria-label="更多操作">
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setTransferring(mailbox)}>
                      <ArrowRightLeft className="size-4 text-ink-tertiary" />
                      过户给其他用户
                    </DropdownMenuItem>
                    <DropdownMenuItem tone="danger" onSelect={() => setReleasing(mailbox)}>
                      <Trash2 className="size-4" />
                      强制释放
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
        </CardList>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>归属用户</TableHead>
              <TableHead>邮件数</TableHead>
              <TableHead>认领时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((mailbox) => (
              <TableRow key={mailbox.id}>
                <TableCell className="font-medium">{mailbox.address}</TableCell>
                <TableCell className="text-ink-secondary">{mailbox.ownerUsername || '—'}</TableCell>
                <TableCell className="text-ink-secondary">{mailbox.messageCount}</TableCell>
                <TableCell className="text-ink-tertiary">{formatDateTime(mailbox.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <IconButton size="sm" aria-label={`过户 ${mailbox.address}`} onClick={() => setTransferring(mailbox)}>
                      <ArrowRightLeft className="size-4" />
                    </IconButton>
                    <IconButton size="sm" aria-label="强制释放" onClick={() => setReleasing(mailbox)}>
                      <Trash2 className="size-4 text-critical" />
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ForceReleaseDialog mailbox={releasing} onClose={() => setReleasing(null)} />
      <TransferMailboxDialog mailbox={transferring} onClose={() => setTransferring(null)} />
    </div>
  );
}
