import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AdminUser } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-session';

function generatePassword(length = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let result = '';
  for (const value of values) result += chars[value % chars.length];
  return result;
}

function ResetPasswordDialog({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [password] = useState(generatePassword);

  const mutation = useMutation({
    mutationFn: (id: number) => adminApi.updateUser(id, { password }),
    onSuccess: () => {
      toast({ title: '密码已重置', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
    },
    onError: () => toast({ title: '重置失败，请重试', variant: 'error' }),
  });

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="重置密码" description={target ? `为用户 ${target.username} 生成临时密码` : undefined} />
        <DialogBody className="flex flex-col gap-3">
          <p className="text-sm text-ink-secondary">下方为临时密码，请复制并转交用户。确认后原密码立即失效。</p>
          <div className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{password}</code>
            <CopyButton value={password} size="sm" />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            loading={mutation.isPending}
            onClick={() => target && mutation.mutate(target.id, { onSuccess: onClose })}
          >
            确认重置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MailboxListDialog({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader
          title="已绑定邮箱"
          description={target ? `${target.username} 名下共 ${target.mailboxCount} 个地址` : undefined}
        />
        <DialogBody className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {target && target.mailboxes.length > 0 ? (
            target.mailboxes.map((address) => (
              <div key={address} className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{address}</code>
                <CopyButton value={address} size="sm" />
              </div>
            ))
          ) : (
            <p className="text-sm text-ink-secondary">该用户尚未绑定任何邮箱地址。</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UsersPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: queryKeys.admin.users, queryFn: () => adminApi.listUsers() });
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [viewingMailboxes, setViewingMailboxes] = useState<AdminUser | null>(null);

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Parameters<typeof adminApi.updateUser>[1] }) =>
      adminApi.updateUser(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users }),
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => adminApi.deleteUser(id),
    onSuccess: () => {
      toast({ title: '用户已删除', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.users });
      setDeleting(null);
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const [search, setSearch] = useState('');
  const users = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = data ?? [];
    return term ? list.filter((u) => u.username.toLowerCase().includes(term)) : list;
  }, [data, search]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="用户管理" description="管理平台账户的角色、状态与密码。" />

      <div className="relative mb-4 max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索用户名"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>邮箱数</TableHead>
              <TableHead>最近登录</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const isSelf = user.id === currentUser.id;
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar avatarUrl={user.avatarUrl} name={user.username} className="size-7 text-xs" />
                      <span className="font-medium">{user.username}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>
                      {user.role === 'admin' ? '管理员' : '普通用户'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={user.status === 'active' ? 'positive' : 'critical'}>
                      {user.status === 'active' ? '正常' : '已禁用'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.mailboxCount > 0 ? (
                      <button
                        type="button"
                        className="text-ink-secondary underline decoration-line underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
                        title="查看绑定邮箱"
                        onClick={() => setViewingMailboxes(user)}
                      >
                        {user.mailboxCount}
                      </button>
                    ) : (
                      <span className="text-ink-secondary">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-ink-tertiary" title={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : ''}>
                    {user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : '从未'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton size="sm" aria-label="更多操作">
                            <MoreHorizontal className="size-4" />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => navigate(`/admin/users/${user.id}/mail`)}>
                            查看邮件
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setViewingMailboxes(user)}>查看绑定邮箱</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isSelf}
                            onSelect={() =>
                              update.mutate({ id: user.id, patch: { role: user.role === 'admin' ? 'user' : 'admin' } })
                            }
                          >
                            {user.role === 'admin' ? '降为普通用户' : '设为管理员'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isSelf}
                            onSelect={() =>
                              update.mutate({
                                id: user.id,
                                patch: { status: user.status === 'active' ? 'disabled' : 'active' },
                              })
                            }
                          >
                            {user.status === 'active' ? '禁用账户' : '启用账户'}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setResetting(user)}>重置密码</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem tone="danger" disabled={isSelf} onSelect={() => setDeleting(user)}>
                            删除用户
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <MailboxListDialog target={viewingMailboxes} onClose={() => setViewingMailboxes(null)} />
      <ResetPasswordDialog target={resetting} onClose={() => setResetting(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title="删除该用户？"
        description={
          deleting
            ? `删除 ${deleting.username} 将释放其 ${deleting.mailboxCount} 个认领地址（可供他人重新认领）、吊销 ${deleting.apiKeyCount} 个 API Key，并清除其头像与星标。邮件本身保留（随地址回未认领态）。此操作不可撤销。`
            : undefined
        }
        confirmLabel="删除"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
