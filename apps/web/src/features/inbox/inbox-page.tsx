import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, MailOpen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MarkAllReadRequest } from '@hpc-mail/shared';
import { messageApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import type { ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useMailboxesQuery, useSharedMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { useDomains } from '@/lib/use-config';
import { FilterBar } from './filter-bar';
import { inboxListQuery } from './inbox-query';
import { MailList } from './mail-list';
import { syncAllRead } from './message-cache';
import { rememberFilterAddress, useInboxFilters } from './use-inbox-filters';
import { useUnreadCount } from './use-unread-count';

const byDomainThenAddress = (a: { domain: string; address: string }, b: { domain: string; address: string }) =>
  a.domain.localeCompare(b.domain) || a.address.localeCompare(b.address);

export function InboxPage() {
  const { filters, setDomain, setAddress, setUnread, setQuery, clearFacets, reset } = useInboxFilters();
  const { data: visibleDomains } = useDomains();
  const ownedQuery = useMailboxesQuery(false);
  const sharedQuery = useSharedMailboxesQuery();
  const { data: mailboxes } = ownedQuery;
  const { data: sharedMailboxes } = sharedQuery;
  const { data: unreadData } = useUnreadCount();
  const queryClient = useQueryClient();
  const [confirmReadAll, setConfirmReadAll] = useState(false);

  // 写信页在没有上次发件身份时，按收件箱当前筛选的地址预选发件人
  useEffect(() => rememberFilterAddress(filters.address), [filters.address]);

  // 全部已读跟随当前筛选（未读开关不缩小范围），只处理自己认领的地址
  const readAllScope = useMemo<MarkAllReadRequest>(
    () => ({
      domain: filters.domain ?? undefined,
      address: filters.address ?? undefined,
      q: filters.q.trim() || undefined,
    }),
    [filters.domain, filters.address, filters.q],
  );
  const scopedReadAll = Boolean(readAllScope.domain || readAllScope.address || readAllScope.q);
  const unreadCount = unreadData?.unread ?? 0;

  const readAll = useMutation({
    mutationFn: (scope: MarkAllReadRequest) => messageApi.markAllRead(scope),
    onSuccess: ({ changed }, scope) => {
      toast({ title: changed > 0 ? `已将 ${changed} 封邮件标为已读` : '没有需要标记的未读邮件', variant: 'success' });
      setConfirmReadAll(false);
      syncAllRead(queryClient, {
        domain: scope.domain,
        address: scope.address,
        q: scope.q,
        ownedAddresses: mailboxes ? new Set(mailboxes.map((mailbox) => mailbox.address)) : undefined,
      });
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  // 地址下拉：按域名分组排序（自己的在前、共享的在后），选了域名时只列该域名下的地址
  const addressOptions = useMemo<ComboboxOption[]>(() => {
    const inDomain = (domain: string) => !filters.domain || domain === filters.domain;
    const owned = (mailboxes ?? [])
      .filter((mailbox) => inDomain(mailbox.domain))
      .sort(byDomainThenAddress)
      .map((mailbox) => ({
        value: mailbox.address,
        label: mailbox.address,
        description: mailbox.displayName || undefined,
      }));
    const ownedAddresses = new Set((mailboxes ?? []).map((mailbox) => mailbox.address));
    const shared = (sharedMailboxes ?? [])
      .filter((mailbox) => !ownedAddresses.has(mailbox.address) && inDomain(mailbox.domain))
      .sort(byDomainThenAddress)
      .map((mailbox) => ({
        value: mailbox.address,
        label: mailbox.address,
        description: mailbox.ownerUsername ? `共享自 ${mailbox.ownerUsername}（只读）` : '共享（只读）',
      }));
    return [...owned, ...shared];
  }, [mailboxes, sharedMailboxes, filters.domain]);

  const domains = useMemo(() => {
    const set = new Set(visibleDomains ?? []);
    for (const mailbox of mailboxes ?? []) set.add(mailbox.domain);
    for (const mailbox of sharedMailboxes ?? []) set.add(mailbox.domain);
    return [...set];
  }, [visibleDomains, mailboxes, sharedMailboxes]);

  const hasActiveFilters = Boolean(filters.domain || filters.address || filters.unread || filters.q);
  const activeFilterLabels = [
    filters.domain && `域名 ${filters.domain}`,
    filters.address && `地址 ${filters.address}`,
    filters.unread && '仅未读',
    filters.q && `关键词“${filters.q}”`,
  ].filter((label): label is string => Boolean(label));
  const addressesReady = mailboxes !== undefined && sharedMailboxes !== undefined;
  const addressError = ownedQuery.isError || sharedQuery.isError;
  const noMailbox = addressesReady && mailboxes.length === 0 && sharedMailboxes.length === 0;

  // 与启动预取同源的请求参数：列表不再等地址列表返回才挂载
  const query = useMemo(() => inboxListQuery(filters), [filters]);

  const readAllLabel = scopedReadAll ? '将当前筛选的未读标为已读' : '全部已读';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="收件箱"
        actions={
          unreadCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              title={scopedReadAll ? `${readAllLabel}（${activeFilterLabels.filter((label) => label !== '仅未读').join('、')}）` : readAllLabel}
              disabled={readAll.isPending}
              onClick={() => (scopedReadAll ? readAll.mutate(readAllScope) : setConfirmReadAll(true))}
            >
              <MailOpen className="size-4" />
              {scopedReadAll ? (
                <>
                  <span className="hidden sm:inline">{readAllLabel}</span>
                  <span className="sm:hidden">筛选结果标为已读</span>
                </>
              ) : (
                readAllLabel
              )}
            </Button>
          )
        }
      />
      {addressError ? (
        <QueryErrorState error={ownedQuery.error ?? sharedQuery.error} onRetry={() => {
          void ownedQuery.refetch();
          void sharedQuery.refetch();
        }} />
      ) : (
        <div className="flex flex-col gap-3">
          {!noMailbox && (
            <FilterBar
              filters={filters}
              domains={domains}
              addressOptions={addressOptions}
              onDomainChange={setDomain}
              onAddressChange={setAddress}
              onUnreadChange={setUnread}
              onQueryChange={setQuery}
              onClearFacets={clearFacets}
            />
          )}
          <MailList
            query={query}
            hasActiveFilters={hasActiveFilters}
            activeFilterLabels={activeFilterLabels}
            onClearFilters={reset}
            emptyTitle="还没有邮件"
            emptyDescription="发送到你已认领或共享给你的地址的邮件会出现在这里。"
            emptyContent={
              // 列表为空时才区分：地址未就绪先占位，两个地址列表都为空才引导认领
              !addressesReady ? (
                <Skeleton className="h-40 w-full rounded-lg" />
              ) : noMailbox ? (
                <div className="rounded-lg border border-line bg-surface">
                  <EmptyState
                    icon={AtSign}
                    title="你还没有认领任何邮箱地址"
                    description="认领一个地址后，发送到它的邮件才会出现在这里。任意前缀 + 开放域名即可，地址全局唯一。"
                    action={
                      <Button asChild>
                        <Link to="/mailboxes?claim=1">去认领一个</Link>
                      </Button>
                    }
                  />
                </div>
              ) : undefined
            }
          />
        </div>
      )}
      <ConfirmDialog
        open={confirmReadAll}
        onOpenChange={setConfirmReadAll}
        title="将全部未读邮件标为已读？"
        description={`你认领的地址中共有 ${unreadCount} 封未读邮件，将全部标为已读。`}
        confirmLabel="全部标为已读"
        loading={readAll.isPending}
        onConfirm={() => readAll.mutate({})}
      />
    </div>
  );
}
