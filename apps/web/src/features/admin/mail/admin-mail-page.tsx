import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { FilterBar } from '@/features/inbox/filter-bar';
import { MailList } from '@/features/inbox/mail-list';
import { useInboxFilters } from '@/features/inbox/use-inbox-filters';
import { useDomains } from '@/lib/use-config';

type Direction = 'inbound' | 'outbound';

const DIRECTION_OPTIONS = [
  { value: 'inbound', label: '已接收' },
  { value: 'outbound', label: '已发送' },
] as const;

const DIRECTION_COPY: Record<
  Direction,
  { description: string; emptyTitle: string; emptyDescription: string }
> = {
  inbound: {
    description: '尚未被任何人认领的地址收到的邮件（catch-all）。已认领地址的信请到对应用户页查看。',
    emptyTitle: '暂无未认领收件',
    emptyDescription: '目前没有未认领地址收到的邮件。',
  },
  outbound: {
    description: '从未认领地址发出的邮件（通常是管理员用任意前缀试投）。用户已发送请到对应用户页查看。',
    emptyTitle: '暂无未认领发件',
    emptyDescription: '目前没有从未认领地址发出的邮件。',
  },
};

/** 全站邮件方向（已接收/已发送）双向绑定 URL；切到已发送时清掉无意义的未读参数 */
export function useAdminMailDirection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const direction: Direction = searchParams.get('direction') === 'outbound' ? 'outbound' : 'inbound';

  const setDirection = useCallback(
    (next: Direction) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'outbound') {
            params.set('direction', 'outbound');
            // outbound 行恒为已读，未读筛选无意义，切换时一并清掉
            params.delete('unread');
          } else {
            params.delete('direction');
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { direction, setDirection };
}

export function AdminMailPage() {
  const { filters, setDomain, setAddress, setUnread, setQuery, reset } = useInboxFilters();
  const { direction, setDirection } = useAdminMailDirection();
  const { data: visibleDomains } = useDomains();

  const isInbound = direction === 'inbound';
  const copy = DIRECTION_COPY[direction];

  const hasActiveFilters = Boolean(filters.domain || (isInbound && filters.unread) || filters.q);

  const query = {
    direction,
    scope: 'unclaimed' as const,
    domain: filters.domain ?? undefined,
    unread: (isInbound && filters.unread) || undefined,
    q: filters.q || undefined,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="全站邮件" description={copy.description} />
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
          addressOptions={[]}
          showUnread={isInbound}
          onDomainChange={setDomain}
          onAddressChange={setAddress}
          onUnreadChange={setUnread}
          onQueryChange={setQuery}
        />
        <MailList
          query={query}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={reset}
          emptyTitle={copy.emptyTitle}
          emptyDescription={copy.emptyDescription}
        />
      </div>
    </div>
  );
}
