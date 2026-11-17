import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Mailbox, MailboxShareGrant } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi, mailboxApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { compareText } from '@/lib/sort';
import { useDebouncedValue } from '@/lib/use-debounced-value';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function MailboxShareDialog({
  grant,
  grants,
  onClose,
  admin = true,
}: {
  grant: MailboxShareGrant | null;
  grants: MailboxShareGrant[];
  onClose: () => void;
  admin?: boolean;
}) {
  const queryClient = useQueryClient();
  const [mailboxId, setMailboxId] = useState<number | null>(grant?.mailboxId ?? null);
  const [selected, setSelected] = useState<number[]>(() => grant?.grantees.map((grantee) => grantee.userId) ?? []);
  const [userQuery, setUserQuery] = useState('');
  const [picked, setPicked] = useState<Array<{ id: number; username: string; status: string }>>([]);

  const current = grants.find((item) => item.mailboxId === mailboxId);
  const mailboxOptions = useMemo(
    () => [...grants].sort((a, b) => compareText(a.address, b.address)).map((item) => ({ value: String(item.mailboxId), label: item.address })),
    [grants],
  );
  const normalized = userQuery.trim().toLowerCase();
  const debounced = useDebouncedValue(normalized, 250);
  const matches = useQuery({
    queryKey: queryKeys.mailboxes.shareUsers(debounced, current?.ownerUserId),
    queryFn: ({ signal }) => mailboxApi.searchShareUsers(debounced, current?.ownerUserId, signal),
    enabled: !admin && grant !== null && debounced.length > 0 && debounced === normalized,
  });
  const users = useQuery({
    queryKey: queryKeys.admin.users,
    queryFn: () => adminApi.listUsers(),
    enabled: admin && grant !== null,
  });

  const candidates = useMemo(() => {
    const term = userQuery.trim().toLowerCase();
    const list: Array<{ id: number; username: string; status: string }> = admin
      ? [...(users.data ?? [])]
      : (normalized === debounced ? matches.data?.items ?? [] : []).map((user) => ({ ...user, status: 'active' }));
    for (const user of picked) {
      if (selected.includes(user.id) && !list.some((item) => item.id === user.id)) list.push(user);
    }
    for (const grantee of current?.grantees ?? []) {
      if (!list.some((user) => user.id === grantee.userId)) {
        list.push({ id: grantee.userId, username: grantee.username, status: grantee.status ?? 'active' });
      }
    }
    return list.filter((user) => {
      if (selected.includes(user.id)) return true;
      if (user.id === current?.ownerUserId || user.status !== 'active') return false;
      if (!term) return true;
      return user.username.toLowerCase().includes(term);
    });
  }, [users.data, matches.data, normalized, debounced, admin, userQuery, current, selected, picked]);
  const invalidSelected = candidates.some((user) => selected.includes(user.id) && user.status !== 'active');

  const save = useMutation({
    mutationFn: () => (admin ? adminApi.replaceMailboxShares : mailboxApi.replaceShares)({
      mailboxId: mailboxId!, userIds: selected, expectedOwnerId: current!.ownerUserId,
    }),
    onSuccess: (updated) => {
      toast({
        title: updated.grantees.length > 0 ? `已共享给 ${updated.grantees.length} 人` : '已清空共享',
        variant: 'success',
      });
      invalidateMailboxOwnership(queryClient);
      onClose();
    },
    onError: (error) => {
      toast({ title: errorText(error, '保存失败，请重试'), variant: 'error' });
      if (error instanceof ApiError && error.code === 'conflict') {
        invalidateMailboxOwnership(queryClient);
        onClose();
      }
    },
  });

  const toggle = (user: { id: number; username: string; status: string }) => {
    const userId = user.id;
    setPicked((prev) => [...prev.filter((item) => item.id !== userId), user]);
    setSelected((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  return (
    <Dialog open={grant !== null} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader
          title="共享邮箱"
          description="成员可查看全部历史来信和新来信、验证码及附件，已读状态由邮箱所有者管理。共享不授予发信、删除权限，也不触发成员通知；撤销后立即失去访问权限。"
        />
        <DialogBody className="flex flex-col gap-3">
          <p className="text-sm text-ink-secondary">邮箱所有者：{current?.ownerUsername}</p>
          {grants.length === 1 ? (
            <p className="break-all rounded-md border border-line bg-canvas px-3 py-2 text-sm font-medium text-ink">
              {current?.address}
            </p>
          ) : <Combobox
            aria-label="选择邮箱"
            disabled={save.isPending}
            value={mailboxId ? String(mailboxId) : null}
            onChange={(value) => {
              if (!value) return;
              const nextId = Number(value);
              setMailboxId(nextId);
              setPicked([]);
              const next = grants.find((item) => item.mailboxId === nextId);
              setSelected(next?.grantees.map((grantee) => grantee.userId) ?? []);
            }}
            options={mailboxOptions}
            clearable={false}
            modal
            placeholder="选择要共享的邮箱"
            searchPlaceholder="搜索邮箱地址…"
            emptyText="没有匹配的邮箱"
          />}
          <Input
            aria-label="搜索共享用户"
            disabled={save.isPending}
            maxLength={32}
            value={userQuery}
            onChange={(event) => setUserQuery(event.target.value)}
            placeholder="搜索用户名"
          />
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            {(admin ? users.isLoading : normalized.length > 0 && (normalized !== debounced || matches.isPending)) ? (
              <p className="px-3 py-4 text-sm text-ink-tertiary">正在加载用户…</p>
            ) : (admin ? users.isError : matches.isError && normalized === debounced) ? (
              <QueryErrorState error={admin ? users.error : matches.error} onRetry={() => void (admin ? users.refetch() : matches.refetch())} />
            ) : candidates.length === 0 ? (
              <p className="px-3 py-4 text-sm text-ink-tertiary">{!admin && !normalized ? '输入用户名查找共享成员' : '没有匹配的启用用户'}</p>
            ) : (
              candidates.map((user) => (
                <label
                  key={user.id}
                  className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-accent"
                    disabled={save.isPending || (!selected.includes(user.id) && selected.length >= 100)}
                    checked={selected.includes(user.id)}
                    onChange={() => toggle(user)}
                  />
                  <span className="text-ink">{user.username}</span>
                  {user.status !== 'active' && <span className="text-xs text-critical">已失效，请取消选择</span>}
                </label>
              ))
            )}
          </div>
          {!admin && matches.data?.hasMore && normalized === debounced && <p className="text-xs text-ink-tertiary">已显示前 20 位匹配用户，请输入更完整的用户名。</p>}
          <p className="text-xs text-ink-tertiary">已选 {selected.length}/100 人。保存后会替换这只邮箱当前的共享名单；取消所有选择可撤销全部共享。</p>
          {invalidSelected && <p role="alert" className="text-sm text-critical">请取消已失效的成员后再保存。</p>}
          {save.isError && <p role="alert" className="text-sm text-critical">{errorText(save.error, '保存失败，请重试')}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} disabled={mailboxId === null || (admin && !users.isSuccess) || invalidSelected} onClick={() => save.mutate()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OwnMailboxShareDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const shares = useQuery({
    queryKey: queryKeys.mailboxes.shares,
    queryFn: () => mailboxApi.listShares(),
    enabled: mailbox !== null,
  });
  const grant = shares.data?.find((item) => item.mailboxId === mailbox?.id);
  if (mailbox && shares.isSuccess && grant) {
    return <MailboxShareDialog key={grant.mailboxId} grant={grant} grants={[grant]} onClose={onClose} admin={false} />;
  }
  return (
    <Dialog open={mailbox !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="分配共享" description={mailbox?.address} />
        <DialogBody>
          {shares.isError ? <QueryErrorState error={shares.error} onRetry={() => void shares.refetch()} />
            : shares.isSuccess ? <p className="text-sm text-critical">邮箱所有者已改变，请关闭并刷新邮箱列表。</p>
            : <p role="status" className="text-sm text-ink-secondary">正在加载共享名单…</p>}
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
