import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserMinus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  type HostedDomain,
  type HostedDomainMember,
  MAX_HOSTED_DOMAIN_MEMBERS,
  updateHostedDomainRequestSchema,
  type UserSearchResult,
} from '@hpc-mail/shared';
import { ApiError, errorMessage } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { hostedDomainApi } from './hosted-domains-api';
import { patchHostedDomain, storeHostedDomain } from './use-hosted-domains';
import { UserSearch } from './user-search';


/** 每位成员的认领上限：本地暂存，点保存提交 */
function MemberLimitForm({ domain }: { domain: HostedDomain }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(String(domain.memberLimit));
  useEffect(() => setDraft(String(domain.memberLimit)), [domain.memberLimit]);

  const parsed = updateHostedDomainRequestSchema.safeParse({ memberLimit: draft.trim() === '' ? Number.NaN : Number(draft) });
  const changed = parsed.success && parsed.data.memberLimit !== domain.memberLimit;

  const save = useMutation({
    mutationFn: (memberLimit: number) => hostedDomainApi.update(domain.id, { memberLimit }),
    onSuccess: (updated) => {
      storeHostedDomain(queryClient, updated);
      toast({ title: '成员认领上限已保存', variant: 'success' });
    },
    onError: (error) => toast({ title: errorMessage(error, '保存失败，请重试'), variant: 'error' }),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.success && changed) save.mutate(parsed.data.memberLimit);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
      <span>每位成员最多认领</span>
      <Input
        type="number"
        min={0}
        max={10000}
        aria-label="每位成员最多认领的地址数"
        className="h-8 w-20 px-2 text-center"
        value={draft}
        invalid={!parsed.success}
        disabled={save.isPending}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="text-ink-tertiary">个地址（0=不限）</span>
      <Button type="submit" size="sm" variant="secondary" loading={save.isPending} disabled={!changed}>
        保存
      </Button>
    </form>
  );
}

/** 所有者与管理员管理成员：搜索添加、移除、设置每人认领上限 */
export function HostedDomainMembersSection({ domain }: { domain: HostedDomain }) {
  const queryClient = useQueryClient();
  const membersKey = queryKeys.hostedDomains.members(domain.id);
  const members = useQuery({ queryKey: membersKey, queryFn: () => hostedDomainApi.members(domain.id) });
  const [removing, setRemoving] = useState<HostedDomainMember | null>(null);
  const list = members.data ?? [];
  const full = list.length >= MAX_HOSTED_DOMAIN_MEMBERS;

  /** 所有者已变化（并发过户）时名单作废：整体刷新该域名 */
  const handleError = (error: unknown, fallback: string) => {
    toast({ title: errorMessage(error, fallback), variant: 'error' });
    if (error instanceof ApiError && error.code === 'conflict') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostedDomains.root });
    }
  };

  const add = useMutation({
    mutationFn: (user: UserSearchResult) =>
      hostedDomainApi.replaceMembers(domain.id, {
        userIds: [...list.map((member) => member.userId), user.id],
        expectedOwnerId: domain.ownerUserId,
      }),
    onSuccess: (next, user) => {
      queryClient.setQueryData(membersKey, next);
      patchHostedDomain(queryClient, domain.id, { memberCount: next.length });
      toast({ title: `已把域名共享给 ${user.username}`, variant: 'success' });
    },
    onError: (error) => handleError(error, '添加失败，请重试'),
  });

  const remove = useMutation({
    mutationFn: (member: HostedDomainMember) => hostedDomainApi.removeMember(domain.id, member.userId),
    onSuccess: (_result, member) => {
      const next = (queryClient.getQueryData<HostedDomainMember[]>(membersKey) ?? []).filter(
        (item) => item.userId !== member.userId,
      );
      queryClient.setQueryData(membersKey, next);
      patchHostedDomain(queryClient, domain.id, { memberCount: next.length });
      toast({ title: `已移除 ${member.username}`, variant: 'success' });
      setRemoving(null);
    },
    onError: (error) => handleError(error, '移除失败，请重试'),
  });

  return (
    <section aria-labelledby="hosted-domain-members" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div>
        <h2 id="hosted-domain-members" className="text-sm font-semibold text-ink">
          成员
        </h2>
        <p className="mt-0.5 text-[13px] text-ink-secondary">
          把域名共享给其他用户后，成员可以在该域名下认领地址，只能看到自己认领的地址的邮件；未认领地址的来信仍归所有者。
          移除成员后，其已认领的地址仍归其所有。
        </p>
      </div>

      <MemberLimitForm domain={domain} />

      {members.isPending ? (
        <Skeleton className="h-16 w-full rounded-md" />
      ) : members.isError ? (
        <QueryErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-tertiary">还没有共享给任何人。</p>
      ) : (
        <ul aria-label="成员列表" className="flex flex-col gap-2">
          {list.map((member) => (
            <li key={member.userId} className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  <span className="truncate">{member.username}</span>
                  {member.status === 'disabled' && <Badge tone="critical">已禁用</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-ink-tertiary">
                  已认领 {member.mailboxCount} 个地址 · 加入于 {formatDateTime(member.grantedAt)}
                </p>
              </div>
              <IconButton
                size="sm"
                aria-label={`移除 ${member.username}`}
                disabled={remove.isPending}
                onClick={() => setRemoving(member)}
              >
                <UserMinus className="size-4 text-critical" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">添加成员</span>
        <UserSearch
          label="搜索要添加的成员"
          actionLabel="添加"
          excludeUserId={domain.ownerUserId}
          hiddenIds={list.map((member) => member.userId)}
          disabled={!members.isSuccess || full || add.isPending}
          onPick={(user) => add.mutate(user)}
        />
        <p className="text-xs text-ink-tertiary">
          已有 {list.length}/{MAX_HOSTED_DOMAIN_MEMBERS} 位成员{full ? '，已达上限' : ''}。
        </p>
      </div>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && !remove.isPending && setRemoving(null)}
        title={`移除成员 ${removing?.username ?? ''}？`}
        description={
          removing
            ? `移除后该成员不能再在 ${domain.domain} 下认领新地址；已认领的 ${removing.mailboxCount} 个地址及其邮件仍归其所有。`
            : undefined
        }
        confirmLabel="移除"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </section>
  );
}
