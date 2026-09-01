import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Mailbox } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';

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
      void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.root });
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
            {mailbox && mailbox.messageCount > 0 && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-critical"
                  checked={deleteHistory}
                  onChange={(event) => setDeleteHistory(event.target.checked)}
                />
                <span className="text-ink">同时永久删除该地址 {mailbox.messageCount} 封历史邮件</span>
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
  const { data: mailboxes, isLoading, isError, error, refetch } = useMailboxesQuery(true);
  const [q, setQ] = useState('');
  const [releasing, setReleasing] = useState<Mailbox | null>(null);

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
      <PageHeader title="全站地址" description="所有已认领地址及其归属，可强制释放（用于治理抢注/清理）。" />
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
                  <div className="flex justify-end">
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
    </div>
  );
}
