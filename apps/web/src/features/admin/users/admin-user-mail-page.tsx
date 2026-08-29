import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import type { ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar } from '@/features/inbox/filter-bar';
import { MailList } from '@/features/inbox/mail-list';
import { useInboxFilters } from '@/features/inbox/use-inbox-filters';
import { useAdminMailDirection } from '@/features/admin/mail/admin-mail-page';
import { useDomains } from '@/lib/use-config';

const DIRECTION_OPTIONS = [
  { value: 'inbound', label: '收件箱' },
  { value: 'outbound', label: '已发送' },
] as const;

export function AdminUserMailPage() {
  const { userId: rawId } = useParams();
  const userId = Number(rawId);
  const { filters, setDomain, setAddress, setUnread, setQuery, reset } = useInboxFilters();
  const { direction, setDirection } = useAdminMailDirection();
  const { data: visibleDomains } = useDomains();
  const { data: users, isLoading } = useQuery({ queryKey: queryKeys.admin.users, queryFn: () => adminApi.listUsers() });

  const user = users?.find((item) => item.id === userId);
  const isInbound = direction === 'inbound';

  const addressOptions = useMemo<ComboboxOption[]>(
    () =>
      (user?.mailboxes ?? []).map((address) => ({
        value: address,
        label: address,
      })),
    [user],
  );

  const hasActiveFilters = Boolean(
    filters.domain || filters.address || (isInbound && filters.unread) || filters.q,
  );

  if (!Number.isInteger(userId) || userId <= 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title="用户不存在" description="无效的用户 id。" className="rounded-lg border border-line bg-surface" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title="用户不存在" className="rounded-lg border border-line bg-surface" />
      </div>
    );
  }

  const query = {
    direction,
    scope: 'user' as const,
    userId,
    domain: filters.domain ?? undefined,
    address: filters.address ?? undefined,
    unread: (isInbound && filters.unread) || undefined,
    q: filters.q || undefined,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`${user.username} 的邮件`}
        description="只读查看该用户已认领地址的收发件。删除请让用户自己操作，或先强制释放地址。"
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link to="/admin/users">
              <ArrowLeft className="size-4" />
              返回用户
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="邮件方向"
          value={direction}
          onValueChange={setDirection}
          options={DIRECTION_OPTIONS}
        />
        <FilterBar
          filters={filters}
          domains={visibleDomains ?? []}
          addressOptions={addressOptions}
          addressLabel="用户地址"
          showUnread={isInbound}
          onDomainChange={setDomain}
          onAddressChange={setAddress}
          onUnreadChange={setUnread}
          onQueryChange={setQuery}
        />
        <MailList
          query={query}
          readOnly
          hasActiveFilters={hasActiveFilters}
          onClearFilters={reset}
          emptyTitle={isInbound ? '该用户还没有收到邮件' : '该用户还没有发送记录'}
          emptyDescription={
            user.mailboxCount === 0
              ? '该用户尚未认领任何地址。'
              : isInbound
                ? '发送到其认领地址的邮件会显示在这里。'
                : '该用户发出的邮件会显示在这里。'
          }
        />
      </div>
    </div>
  );
}
