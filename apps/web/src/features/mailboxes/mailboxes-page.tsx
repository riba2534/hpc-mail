import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Mailbox } from '@hpc-mail/shared';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useDomains } from '@/lib/use-config';
import { useIsMobile } from '@/lib/use-media-query';
import { ClaimDialog } from './claim-dialog';
import { useMailboxesQuery } from './use-mailboxes';

function EditMailboxDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    setDisplayName(mailbox?.displayName ?? '');
  }, [mailbox?.id, mailbox?.displayName]);

  const mutation = useMutation({
    mutationFn: (id: number) => mailboxApi.update(id, { displayName: displayName.trim() }),
    onSuccess: () => {
      toast({ title: '备注已更新', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.root });
      onClose();
    },
    onError: () => toast({ title: '更新失败，请重试', variant: 'error' }),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (mailbox) mutation.mutate(mailbox.id);
  };

  return (
    <Dialog open={mailbox !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="编辑备注" description={mailbox?.address} />
        <form onSubmit={handleSubmit}>
          <DialogBody>
            <FormField label="备注名">
              {(field) => (
                <Input
                  {...field}
                  autoFocus
                  maxLength={64}
                  placeholder="便于识别的名称"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              )}
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReleaseDialog({
  mailbox,
  onClose,
  onReleased,
}: {
  mailbox: Mailbox | null;
  onClose: () => void;
  onReleased: () => void;
}) {
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
          ? `地址已释放，删除 ${res.deletedMessages} 封历史邮件`
          : '地址已释放',
        variant: 'success',
      });
      onReleased();
      onClose();
    },
    onError: () => toast({ title: '释放失败，请重试', variant: 'error' }),
  });

  return (
    <Dialog open={mailbox !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="释放这个地址？" description={mailbox?.address} />
        <DialogBody>
          <div className="flex flex-col gap-3 text-sm text-ink-secondary">
            <p>释放后该地址回到未认领状态，其他用户可重新认领。</p>
            {mailbox && (
              <div className="rounded-md border border-caution/40 bg-caution-soft/40 p-3 text-ink">
                <p className="font-medium text-caution">
                  当前已加载的历史邮件数：{mailbox.messageCount}（可能有新来信）
                </p>
                <p className="mt-1 text-xs text-ink-secondary">
                  若不删除，下一个认领此地址的人将看到这些邮件的<b>全部内容</b>（含验证码、账单等敏感信息）。
                </p>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-critical"
                    checked={deleteHistory}
                    onChange={(event) => setDeleteHistory(event.target.checked)}
                  />
                  <span className="text-sm text-ink">同时永久删除该地址的全部历史邮件</span>
                </label>
              </div>
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
            {deleteHistory ? '释放并删除历史' : '释放'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const inboxHref = (address: string) => `/inbox?address=${encodeURIComponent(address)}`;

/** 地址：点击进入只看该地址的收件箱，旁边一键复制 */
function AddressCell({ address }: { address: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link
        to={inboxHref(address)}
        title="查看该地址的邮件"
        className="truncate font-medium text-ink underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {address}
      </Link>
      <CopyButton value={address} ariaLabel={`复制 ${address}`} size="sm" className="h-7 shrink-0 border-transparent px-1.5" />
    </span>
  );
}

function MailboxCards({
  items,
  onEdit,
  onRelease,
}: {
  items: Mailbox[];
  onEdit: (mailbox: Mailbox) => void;
  onRelease: (mailbox: Mailbox) => void;
}) {
  const navigate = useNavigate();
  return (
    <CardList>
      {items.map((mailbox) => (
        <CardListItem
          key={mailbox.id}
          title={<AddressCell address={mailbox.address} />}
          subtitle={mailbox.displayName || undefined}
          meta={
            <>
              <span>{mailbox.messageCount} 封邮件</span>
              <span>认领于 {formatDateTime(mailbox.createdAt)}</span>
            </>
          }
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" aria-label={`${mailbox.address} 的更多操作`}>
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => navigate(inboxHref(mailbox.address))}>
                  <Inbox className="size-4 text-ink-tertiary" />
                  查看邮件
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEdit(mailbox)}>
                  <Pencil className="size-4 text-ink-tertiary" />
                  编辑备注
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => onRelease(mailbox)}>
                  <Trash2 className="size-4" />
                  释放地址
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      ))}
    </CardList>
  );
}

export function MailboxesPage() {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const domainsQuery = useDomains();
  const { data: visibleDomains } = domainsQuery;
  const { data: mailboxes, isLoading, isError, error, refetch } = useMailboxesQuery(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [claimOpen, setClaimOpen] = useState(false);
  const [releasing, setReleasing] = useState<Mailbox | null>(null);
  const [editing, setEditing] = useState<Mailbox | null>(null);

  const invalidateMailboxes = () =>
    invalidateMailboxOwnership(queryClient);

  // /mailboxes?claim=1：从空收件箱等入口直达认领。域名就绪后打开一次并清掉参数，刷新不会重复弹出
  const wantsClaim = searchParams.get('claim') === '1';
  useEffect(() => {
    if (!wantsClaim || visibleDomains === undefined) return;
    if (visibleDomains.length > 0) setClaimOpen(true);
    else toast({ title: '暂无可认领的域名', description: '管理员开放域名后即可认领地址。' });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('claim');
        return next;
      },
      { replace: true },
    );
  }, [wantsClaim, visibleDomains, setSearchParams]);

  const items = mailboxes ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="我的邮箱"
        description="认领任意前缀 + 系统域名的地址，全局唯一占用。"
        actions={
          <Button disabled={!visibleDomains?.length} onClick={() => setClaimOpen(true)}>
            <Plus className="size-4" />
            认领地址
          </Button>
        }
      />
      {domainsQuery.isError && <QueryErrorState error={domainsQuery.error} onRetry={() => void domainsQuery.refetch()} className="mb-4" />}

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={AtSign}
          title="还没有认领任何地址"
          description="认领一个地址后即可收发邮件。"
          action={<Button disabled={!visibleDomains?.length} onClick={() => setClaimOpen(true)}>认领地址</Button>}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <MailboxCards items={items} onEdit={setEditing} onRelease={setReleasing} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>备注</TableHead>
              <TableHead>邮件数</TableHead>
              <TableHead>认领时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((mailbox) => (
              <TableRow key={mailbox.id}>
                <TableCell>
                  <AddressCell address={mailbox.address} />
                </TableCell>
                <TableCell className="text-ink-secondary">{mailbox.displayName || '—'}</TableCell>
                <TableCell className="text-ink-secondary">{mailbox.messageCount}</TableCell>
                <TableCell className="text-ink-tertiary">{formatDateTime(mailbox.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <IconButton size="sm" aria-label="编辑备注" onClick={() => setEditing(mailbox)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton size="sm" aria-label="释放地址" onClick={() => setReleasing(mailbox)}>
                      <Trash2 className="size-4 text-critical" />
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ClaimDialog open={claimOpen} onOpenChange={setClaimOpen} domains={visibleDomains ?? []} />
      <EditMailboxDialog mailbox={editing} onClose={() => setEditing(null)} />
      <ReleaseDialog
        mailbox={releasing}
        onClose={() => setReleasing(null)}
        onReleased={invalidateMailboxes}
      />
    </div>
  );
}
