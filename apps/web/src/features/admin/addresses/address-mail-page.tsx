import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useAdminMailDirection } from '@/features/admin/mail/admin-mail-page';
import { FilterBar } from '@/features/inbox/filter-bar';
import { MailList } from '@/features/inbox/mail-list';
import { useInboxFilters } from '@/features/inbox/use-inbox-filters';
import { findLoadedAdminMailbox } from './admin-mailboxes';

const DIRECTION_OPTIONS = [
  { value: 'inbound', label: '收件箱' },
  { value: 'outbound', label: '已发送' },
] as const;

const noop = () => {};

function BackToAddresses() {
  return (
    <Button asChild variant="secondary" size="sm">
      <Link to="/admin/addresses">
        <ArrowLeft className="size-4" />
        返回全站地址
      </Link>
    </Button>
  );
}

const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.httpStatus === 404 || error.code === 'not_found');

/** 按 id 只读这一个邮箱；从全站地址列表进来时先用列表缓存里的这一行渲染，不必等请求返回 */
function useAdminMailbox(mailboxId: number, enabled: boolean) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.mailboxes.adminDetail(mailboxId),
    queryFn: () => adminApi.getMailbox(mailboxId),
    enabled,
    placeholderData: () => findLoadedAdminMailbox(queryClient, mailboxId),
  });
}

/** 管理员只读查看某个已认领地址的全部收件与发件；地址固定，不随 URL 中的 domain/address 变化 */
export function AdminAddressMailPage() {
  const { mailboxId: rawId } = useParams();
  const mailboxId = Number(rawId);
  const validId = Number.isInteger(mailboxId) && mailboxId > 0;
  const { data: mailbox, isLoading, isPlaceholderData, isError, error, refetch } = useAdminMailbox(mailboxId, validId);
  const { filters, setUnread, setQuery, reset } = useInboxFilters();
  const { direction, setDirection } = useAdminMailDirection();

  if (!validId) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState title="地址不存在" description="无效的地址 id。" className="rounded-lg border border-line bg-surface" />
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

  if (isError && !isNotFound(error)) {
    return (
      <div className="mx-auto max-w-4xl">
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  // 刷新返回 404 时 TanStack 仍保留上次的 data：只要是 404 就按已释放处理，不再展示旧地址
  if (!mailbox || isNotFound(error)) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="地址不存在" actions={<BackToAddresses />} />
        <EmptyState
          title="没有找到这个地址"
          description="它可能已被释放，回到全站地址列表重新查找。"
          className="rounded-lg border border-line bg-surface"
        />
      </div>
    );
  }

  const isInbound = direction === 'inbound';
  const hasActiveFilters = Boolean((isInbound && filters.unread) || filters.q);
  const query = {
    direction,
    scope: 'user' as const,
    userId: mailbox.userId,
    address: mailbox.address,
    unread: (isInbound && filters.unread) || undefined,
    q: filters.q || undefined,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={<span className="break-all">{mailbox.address}</span>}
        description={
          <>
            归属{' '}
            <Link to={`/admin/users/${mailbox.userId}/mail`} className="text-accent hover:underline">
              {mailbox.ownerUsername || '未知用户'}
            </Link>
            ，共 {mailbox.messageCount} 封邮件。只读查看，删除请让用户自己操作，或先强制释放地址。
          </>
        }
        actions={<BackToAddresses />}
      />
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="邮件方向"
          value={direction}
          onValueChange={setDirection}
          options={DIRECTION_OPTIONS}
          className="self-start"
        />
        <FilterBar
          filters={{ ...filters, domain: null, address: null }}
          domains={[]}
          addressOptions={[]}
          showUnread={isInbound}
          onDomainChange={noop}
          onAddressChange={noop}
          onUnreadChange={setUnread}
          onQueryChange={setQuery}
        />
        {/* 列表缓存里的这一行可能已过期（过户、释放后只标记了 stale）：只拿来先显示头部，
            邮件列表按归属人查询，等真实数据返回再挂载，免得用旧 userId 发请求、闪出错误结果 */}
        {isPlaceholderData ? (
          <Skeleton className="h-48 w-full rounded-lg" />
        ) : (
          <MailList
            query={query}
            readOnly
            hasActiveFilters={hasActiveFilters}
            onClearFilters={reset}
            emptyTitle={isInbound ? '该地址还没有收到邮件' : '该地址还没有发送记录'}
            emptyDescription={isInbound ? '发送到这个地址的邮件会显示在这里。' : '从这个地址发出的邮件会显示在这里。'}
          />
        )}
      </div>
    </div>
  );
}
