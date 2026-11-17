import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, Inbox, MoreHorizontal, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
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
import { useMailboxesQuery, useSharedMailboxesQuery } from './use-mailboxes';
import { OwnMailboxShareDialog } from './mailbox-share-dialog';

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
    meta: { errorTitle: '备注更新失败' },
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
    meta: { errorTitle: '释放失败' },
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
  onShare,
}: {
  items: Mailbox[];
  onEdit: (mailbox: Mailbox) => void;
  onRelease: (mailbox: Mailbox) => void;
  onShare: (mailbox: Mailbox) => void;
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
                <DropdownMenuItem onSelect={() => onShare(mailbox)}>
                  <Share2 className="size-4 text-ink-tertiary" />
                  共享邮箱
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
  const { data: mailboxes, isLoading, isError, error, refetch } = useMailboxesQuery();
  const shared = useSharedMailboxesQuery();
  const [searchParams, setSearchParams] = useSearchParams();
  const [claimOpen, setClaimOpen] = useState(false);
  /** 认领弹窗预选的域名：/mailboxes?claim=1&domain=… 带入 */
  const [claimDomain, setClaimDomain] = useState<string | undefined>();
  const [releasing, setReleasing] = useState<Mailbox | null>(null);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [sharing, setSharing] = useState<Mailbox | null>(null);

  const invalidateMailboxes = () =>
    invalidateMailboxOwnership(queryClient);

  // /mailboxes?claim=1[&domain=…]：从空收件箱、托管域名详情等入口直达认领。域名就绪后打开一次并清掉参数，刷新不会重复弹出
  const wantsClaim = searchParams.get('claim') === '1';
  const wantedDomain = searchParams.get('domain') ?? undefined;
  useEffect(() => {
    if (!wantsClaim || visibleDomains === undefined) return;
    if (visibleDomains.length > 0) {
      setClaimDomain(wantedDomain);
      setClaimOpen(true);
    } else toast({ title: '暂无可认领的域名', description: '请联系管理员配置可认领的域名。' });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('claim');
        next.delete('domain');
        return next;
      },
      { replace: true },
    );
  }, [wantsClaim, wantedDomain, visibleDomains, setSearchParams]);

  const items = mailboxes ?? [];
  /** 页面上的认领按钮不预选域名 */
  const openClaim = () => {
    setClaimDomain(undefined);
    setClaimOpen(true);
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="我的邮箱"
        description="认领邮箱地址收发邮件，也可把来信只读共享给其他用户。"
        actions={
          <Button disabled={!visibleDomains?.length} onClick={openClaim}>
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
          action={<Button disabled={!visibleDomains?.length} onClick={openClaim}>认领地址</Button>}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <MailboxCards items={items} onEdit={setEditing} onRelease={setReleasing} onShare={setSharing} />
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
                    <IconButton size="sm" aria-label={`共享 ${mailbox.address}`} onClick={() => setSharing(mailbox)}>
                      <Share2 className="size-4" />
                    </IconButton>
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

      <section className="mt-8" aria-label="共享给我的邮箱">
        <h2 className="text-base font-semibold text-ink">共享给我的邮箱</h2>
        <p className="mb-3 mt-1 text-sm text-ink-secondary">可查看历史和新来信、验证码与附件；只读共享不提供发信或删除权限。</p>
        {shared.isLoading ? <Skeleton className="h-24 w-full rounded-lg" />
          : shared.isError ? <QueryErrorState error={shared.error} onRetry={() => void shared.refetch()} />
          : !shared.data?.length ? <p className="text-sm text-ink-tertiary">暂无共享给你的邮箱。</p>
          : <CardList>
            {shared.data.map((mailbox) => <CardListItem key={mailbox.mailboxId}
              title={<AddressCell address={mailbox.address} />}
              subtitle={`所有者：${mailbox.ownerUsername}`}
              meta={<span>只读共享{mailbox.displayName ? ` · ${mailbox.displayName}` : ''}</span>}
              actions={<Button asChild size="sm" variant="secondary"><Link to={inboxHref(mailbox.address)}>查看来信</Link></Button>}
            />)}
          </CardList>}
      </section>

      <ClaimDialog open={claimOpen} onOpenChange={setClaimOpen} domains={visibleDomains ?? []} initialDomain={claimDomain} />
      <EditMailboxDialog mailbox={editing} onClose={() => setEditing(null)} />
      {sharing && <OwnMailboxShareDialog key={sharing.id} mailbox={sharing} onClose={() => setSharing(null)} />}
      <ReleaseDialog
        mailbox={releasing}
        onClose={() => setReleasing(null)}
        onReleased={invalidateMailboxes}
      />
    </div>
  );
}
