import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Mailbox, TransferMailboxRequest } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { toast } from '@/components/ui/toast';

export function TransferMailboxDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const client = useQueryClient();
  const [userId, setUserId] = useState('');
  const users = useQuery({ queryKey: queryKeys.admin.users, queryFn: adminApi.listUsers, enabled: mailbox !== null });
  const targets = (users.data ?? []).filter(user => user.status === 'active' && user.id !== mailbox?.userId);
  const target = targets.find(user => String(user.id) === userId);
  useEffect(() => setUserId(''), [mailbox?.id]);
  const transfer = useMutation({
    mutationFn: ({ id, body }: { id: number; body: TransferMailboxRequest }) => adminApi.transferMailbox(id, body),
    onSuccess: result => {
      toast({ title: result.transferred ? `邮箱已过户给 ${result.mailbox.ownerUsername}` : '邮箱已属于目标用户', variant: 'success' });
      invalidateMailboxOwnership(client);
      onClose();
    },
    onError: error => {
      toast({ title: error instanceof ApiError ? error.message : '过户失败，请重试', variant: 'error' });
      if (error instanceof ApiError && error.code === 'conflict') {
        invalidateMailboxOwnership(client);
        onClose();
      }
    },
  });

  return (
    <Dialog open={mailbox !== null} onOpenChange={next => !next && !transfer.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="过户邮箱" description={mailbox?.address} />
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm text-ink-secondary">当前主人：<b className="text-ink">{mailbox?.ownerUsername || '未知用户'}</b>。过户后，目标用户将获得完整收发权限及全部历史邮件、附件，旧共享授权将全部撤销。</p>
          {users.isError ? <QueryErrorState error={users.error} onRetry={() => void users.refetch()} /> : (
            <FormField label="目标用户" required>
              {field => <select {...field} value={userId} onChange={event => setUserId(event.target.value)} disabled={users.isPending || transfer.isPending}
                className="h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
                <option value="">{users.isPending ? '正在加载用户…' : targets.length ? '请选择目标用户' : '没有其他启用中的用户'}</option>
                {targets.map(user => <option key={user.id} value={user.id}>{user.username}{user.role === 'admin' ? '（管理员）' : ''}</option>)}
              </select>}
            </FormField>
          )}
          <p className="text-sm text-ink-secondary">管理员过户不受认领配额、保留前缀和域名公开性限制。之后的新邮件按新主人的个人设置通知和转发；已有通知不重复发送。</p>
          {target && <p className="text-sm text-ink">确认将 {mailbox?.address} 从 {mailbox?.ownerUsername} 过户给 <b>{target.username}</b>。</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={transfer.isPending} onClick={onClose}>取消</Button>
          <Button loading={transfer.isPending} disabled={!target || users.isError || transfer.isPending} onClick={() => mailbox && target && transfer.mutate({
            id: mailbox.id, body: { userId: target.id, expectedOwnerId: mailbox.userId },
          })}>确认过户</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
