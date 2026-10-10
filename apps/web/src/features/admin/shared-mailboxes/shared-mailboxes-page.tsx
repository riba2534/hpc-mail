import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Search, Share2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MailboxShareGrant } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useIsMobile } from '@/lib/use-media-query';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function ShareDialog({
  grant,
  grants,
  onClose,
}: {
  grant: MailboxShareGrant | null;
  grants: MailboxShareGrant[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [mailboxId, setMailboxId] = useState<number | null>(grant?.mailboxId ?? null);
  const [selected, setSelected] = useState<number[]>(() => grant?.grantees.map((grantee) => grantee.userId) ?? []);
  const [userQuery, setUserQuery] = useState('');

  const users = useQuery({
    queryKey: queryKeys.admin.users,
    queryFn: () => adminApi.listUsers(),
    enabled: grant !== null,
  });

  const candidates = useMemo(() => {
    const term = userQuery.trim().toLowerCase();
    const list: Array<{ id: number; username: string; role: string; status: string }> = [...(users.data ?? [])];
    const current = grants.find((item) => item.mailboxId === mailboxId);
    for (const grantee of current?.grantees ?? []) {
      if (!list.some((user) => user.id === grantee.userId)) {
        list.push({ id: grantee.userId, username: grantee.username, role: 'user', status: 'disabled' });
      }
    }
    return list.filter((user) => {
      if (selected.includes(user.id)) return true;
      if (user.role !== 'user' || user.status !== 'active') return false;
      if (!term) return true;
      return user.username.toLowerCase().includes(term);
    });
  }, [users.data, userQuery, grants, mailboxId, selected]);
  const invalidSelected = candidates.some((user) => selected.includes(user.id) && (user.role !== 'user' || user.status !== 'active'));

  const save = useMutation({
    mutationFn: () => adminApi.replaceMailboxShares({ mailboxId: mailboxId!, userIds: selected }),
    onSuccess: (updated) => {
      toast({
        title: updated.grantees.length > 0 ? `已共享给 ${updated.grantees.length} 人` : '已清空共享',
        variant: 'success',
      });
      invalidateMailboxOwnership(queryClient);
      onClose();
    },
    onError: (error) => toast({ title: errorText(error, '保存失败，请重试'), variant: 'error' }),
  });

  const toggle = (userId: number) => {
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  return (
    <Dialog open={grant !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader
          title="分配共享"
          description="共享后用户立即可见该邮箱的全部历史来信和新来信，已读状态由共享者共用。撤销后失去访问权限；发信、删除和通知仍属于你。"
        />
        <DialogBody className="flex flex-col gap-3">
          <Select
            value={mailboxId ? String(mailboxId) : undefined}
            onValueChange={(value) => {
              const nextId = Number(value);
              setMailboxId(nextId);
              const next = grants.find((item) => item.mailboxId === nextId);
              setSelected(next?.grantees.map((grantee) => grantee.userId) ?? []);
            }}
          >
            <SelectTrigger aria-label="选择邮箱">
              <SelectValue placeholder="选择要共享的邮箱" />
            </SelectTrigger>
            <SelectContent>
              {grants.map((item) => (
                <SelectItem key={item.mailboxId} value={String(item.mailboxId)}>
                  {item.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="搜索共享用户"
            value={userQuery}
            onChange={(event) => setUserQuery(event.target.value)}
            placeholder="搜索用户名"
          />
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            {users.isLoading ? (
              <p className="px-3 py-4 text-sm text-ink-tertiary">正在加载用户…</p>
            ) : users.isError ? (
              <QueryErrorState error={users.error} onRetry={() => void users.refetch()} />
            ) : candidates.length === 0 ? (
              <p className="px-3 py-4 text-sm text-ink-tertiary">没有可共享的普通用户</p>
            ) : (
              candidates.map((user) => (
                <label
                  key={user.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    checked={selected.includes(user.id)}
                    onChange={() => toggle(user.id)}
                  />
                  <span className="text-ink">{user.username}</span>
                  {(user.status !== 'active' || user.role !== 'user') && <span className="text-xs text-critical">已失效，请取消选择</span>}
                </label>
              ))
            )}
          </div>
          <p className="text-xs text-ink-tertiary">已选 {selected.length} 人。保存后会替换这只邮箱当前的共享名单。</p>
          {invalidSelected && <p role="alert" className="text-sm text-critical">请取消已失效的成员后再保存。</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} disabled={mailboxId === null || !users.isSuccess || invalidSelected} onClick={() => save.mutate()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SharedMailboxesPage() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: queryKeys.admin.mailboxShares,
    queryFn: () => adminApi.listMailboxShares(),
  });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<MailboxShareGrant | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    mailboxId: number;
    userId: number;
    address: string;
    username: string;
  } | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = shares.data ?? [];
    if (!term) return list;
    return list.filter(
      (item) =>
        item.address.includes(term) ||
        item.grantees.some((grantee) => grantee.username.toLowerCase().includes(term)),
    );
  }, [shares.data, q]);

  const revoke = useMutation({
    mutationFn: (target: NonNullable<typeof revokeTarget>) =>
      adminApi.revokeMailboxShare(target.mailboxId, target.userId),
    onSuccess: () => {
      toast({ title: '已取消共享', variant: 'success' });
      invalidateMailboxOwnership(queryClient);
      setRevokeTarget(null);
    },
    onError: (error) => toast({ title: errorText(error, '取消失败，请重试'), variant: 'error' }),
  });

  const dialogGrant = creating ? (shares.data?.[0] ?? null) : editing;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="共享邮箱"
        description="把你已经认领的邮箱分给普通用户。对方能看来信和验证码，不能用这个地址发信或删信。"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
            disabled={!shares.data?.length}
          >
            <Share2 className="size-4" />
            分配共享
          </Button>
        }
      />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索地址或用户名" className="pl-9" />
      </div>

      {shares.isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : shares.isError ? (
        <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Share2}
          title={q ? '没有匹配的邮箱' : '你还没有认领邮箱'}
          description={q ? undefined : '先在「我的邮箱」认领一个地址，再回来把它共享给用户。'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {filtered.map((item) => (
            <CardListItem
              key={item.mailboxId}
              title={<span className="truncate">{item.address}</span>}
              subtitle={item.grantees.length === 0 ? '尚未共享' : `共享给 ${item.grantees.length} 人`}
              meta={
                item.grantees.length > 0 ? (
                  <>
                    {item.grantees.map((grantee) => (
                      <Badge key={grantee.userId} tone="neutral">
                        {grantee.username}
                      </Badge>
                    ))}
                  </>
                ) : undefined
              }
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton size="sm" aria-label="更多操作">
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      onSelect={() => {
                        setCreating(false);
                        setEditing(item);
                      }}
                    >
                      编辑共享名单
                    </DropdownMenuItem>
                    {item.grantees.length > 0 && <DropdownMenuSeparator />}
                    {item.grantees.map((grantee) => (
                      <DropdownMenuItem
                        key={grantee.userId}
                        tone="danger"
                        onSelect={() =>
                          setRevokeTarget({
                            mailboxId: item.mailboxId,
                            userId: grantee.userId,
                            address: item.address,
                            username: grantee.username,
                          })
                        }
                      >
                        取消与 {grantee.username} 共享
                      </DropdownMenuItem>
                    ))}
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
              <TableHead>共享给</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.mailboxId}>
                <TableCell className="font-medium">{item.address}</TableCell>
                <TableCell>
                  {item.grantees.length === 0 ? (
                    <span className="text-ink-tertiary">尚未共享</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {item.grantees.map((grantee) => (
                        <Badge key={grantee.userId} tone="neutral" className="gap-1">
                          {grantee.username}
                          <button
                            type="button"
                            aria-label={`取消与 ${grantee.username} 共享 ${item.address}`}
                            className="rounded-sm hover:text-critical"
                            onClick={() =>
                              setRevokeTarget({
                                mailboxId: item.mailboxId,
                                userId: grantee.userId,
                                address: item.address,
                                username: grantee.username,
                              })
                            }
                          >
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCreating(false);
                        setEditing(item);
                      }}
                    >
                      编辑
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ShareDialog
        key={creating ? 'create' : String(editing?.mailboxId ?? 'closed')}
        grant={creating || editing ? dialogGrant : null}
        grants={shares.data ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="取消共享"
        description={
          revokeTarget
            ? `${revokeTarget.username} 将不能再看到 ${revokeTarget.address} 的邮件。地址和历史邮件都保留。`
            : undefined
        }
        confirmLabel="取消共享"
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget)}
      />
    </div>
  );
}
