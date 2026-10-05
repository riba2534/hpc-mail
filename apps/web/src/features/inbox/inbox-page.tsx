import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, MailOpen } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import type { ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { useMailboxesQuery, useSharedMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { useDomains } from '@/lib/use-config';
import { FilterBar } from './filter-bar';
import { MailList } from './mail-list';
import { useInboxFilters } from './use-inbox-filters';
import { useUnreadCount } from './use-unread-count';

export function InboxPage() {
  const { filters, setDomain, setAddress, setUnread, setQuery, reset } = useInboxFilters();
  const { data: visibleDomains } = useDomains();
  const ownedQuery = useMailboxesQuery(false);
  const sharedQuery = useSharedMailboxesQuery();
  const { data: mailboxes } = ownedQuery;
  const { data: sharedMailboxes } = sharedQuery;
  const { data: unreadData } = useUnreadCount();
  const queryClient = useQueryClient();

  const readAll = useMutation({
    mutationFn: () => messageApi.markAllRead(),
    onSuccess: ({ changed }) => {
      toast({ title: changed > 0 ? `已将 ${changed} 封邮件标为已读` : '没有未读邮件', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
    },
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const addressOptions = useMemo<ComboboxOption[]>(() => {
    const owned = (mailboxes ?? []).map((mailbox) => ({
      value: mailbox.address,
      label: mailbox.address,
      description: mailbox.displayName || undefined,
    }));
    const ownedAddresses = new Set(owned.map((option) => option.value));
    const shared = (sharedMailboxes ?? [])
      .filter((mailbox) => !ownedAddresses.has(mailbox.address))
      .map((mailbox) => ({
        value: mailbox.address,
        label: mailbox.address,
        description: '共享',
      }));
    return [...owned, ...shared];
  }, [mailboxes, sharedMailboxes]);

  const domains = useMemo(() => {
    const set = new Set(visibleDomains ?? []);
    for (const mailbox of mailboxes ?? []) set.add(mailbox.domain);
    for (const mailbox of sharedMailboxes ?? []) set.add(mailbox.domain);
    return [...set];
  }, [visibleDomains, mailboxes, sharedMailboxes]);

  const hasActiveFilters = Boolean(filters.domain || filters.address || filters.unread || filters.q);
  const addressesReady = mailboxes !== undefined && sharedMailboxes !== undefined;
  const addressError = ownedQuery.isError || sharedQuery.isError;
  const noMailbox = addressesReady && mailboxes.length === 0 && sharedMailboxes.length === 0;

  const query = {
    direction: 'inbound' as const,
    scope: 'mine' as const,
    domain: filters.domain ?? undefined,
    address: filters.address ?? undefined,
    unread: filters.unread || undefined,
    q: filters.q || undefined,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="收件箱"
        actions={
          (unreadData?.unread ?? 0) > 0 && (
            <Button variant="secondary" size="sm" disabled={readAll.isPending} onClick={() => readAll.mutate()}>
              <MailOpen className="size-4" />
              全部已读
            </Button>
          )
        }
      />
      {addressError ? (
        <QueryErrorState error={ownedQuery.error ?? sharedQuery.error} onRetry={() => {
          void ownedQuery.refetch();
          void sharedQuery.refetch();
        }} />
      ) : !addressesReady ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : noMailbox ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState
            icon={AtSign}
            title="你还没有认领任何邮箱地址"
            description="认领一个地址后，发送到它的邮件才会出现在这里。任意前缀 + 开放域名即可，地址全局唯一。"
            action={
              <Button asChild>
                <Link to="/mailboxes">去认领一个</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FilterBar
            filters={filters}
            domains={domains}
            addressOptions={addressOptions}
            onDomainChange={setDomain}
            onAddressChange={setAddress}
            onUnreadChange={setUnread}
            onQueryChange={setQuery}
          />
          <MailList
            query={query}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={reset}
            emptyTitle="还没有邮件"
            emptyDescription="发送到你已认领或共享给你的地址的邮件会出现在这里。"
          />
        </div>
      )}
    </div>
  );
}
