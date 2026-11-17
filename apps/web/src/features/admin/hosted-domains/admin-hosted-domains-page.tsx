import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Network, Search } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { HostedDomain, HostedDomainsHealth, HostedDomainStatus } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useIsMobile } from '@/lib/use-media-query';
import {
  HOSTED_DOMAIN_STATUS_OPTIONS,
  HostedDomainStatusBadge,
} from '@/features/hosted-domains/hosted-domain-meta';
import { adminHostedDomainApi } from '@/features/hosted-domains/hosted-domains-api';
import { storeHostedDomain } from '@/features/hosted-domains/use-hosted-domains';
import { LoadMoreFooter } from '@/components/load-more-footer';
import { useDebouncedValue } from '@/lib/use-debounced-value';

const ALL_STATUSES = 'all';
/** 每页条数（服务端上限 200） */
const PAGE_SIZE = 100;

interface PendingAction {
  domain: HostedDomain;
  kind: 'suspend' | 'resume';
}

const detailHref = (domain: HostedDomain) => `/domains/${domain.id}`;

function HealthItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-ink-tertiary">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** 运行条件：总开关、Cloudflare 凭据、站长账户 zone 余量 */
function HealthCard() {
  const health = useQuery({
    queryKey: queryKeys.admin.hostedDomainsHealth,
    queryFn: () => adminHostedDomainApi.health(),
    staleTime: 60_000,
    retry: false,
  });

  if (health.isPending) return <Skeleton className="h-28 w-full rounded-lg" />;
  if (health.isError) return <QueryErrorState error={health.error} onRetry={() => void health.refetch()} />;

  const data: HostedDomainsHealth = health.data;
  const zones = data.accountZones;
  const pending = data.accountPendingZones;
  // Cloudflare：账户超过 50 个 zone 且 pending 多于 active 时禁止新增
  const blocked = zones !== null && pending !== null && zones > 50 && pending > zones - pending;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink">运行状态</h2>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <HealthItem label="总开关">
          <Badge tone={data.enabled ? 'positive' : 'neutral'}>{data.enabled ? '已开启' : '已关闭'}</Badge>
        </HealthItem>
        <HealthItem label="Cloudflare 凭据">
          {!data.configured ? (
            <Badge tone="caution">未配置</Badge>
          ) : data.tokenValid === false ? (
            <Badge tone="critical">无效</Badge>
          ) : data.tokenValid ? (
            <Badge tone="positive">有效</Badge>
          ) : (
            <Badge>未校验</Badge>
          )}
        </HealthItem>
        <HealthItem label="站长账户 zone">
          {zones === null ? '—' : `共 ${zones} 个，等待生效 ${pending ?? '—'} 个`}
        </HealthItem>
      </dl>
      {!data.configured && (
        <p className="text-[13px] text-ink-secondary">
          Worker 尚未配置 Cloudflare 凭据（cf_api_token、cf_account_id），用户无法添加托管域名。
        </p>
      )}
      {data.error && <p className="break-words text-[13px] text-critical">{data.error}</p>}
      <p className={blocked ? 'text-[13px] text-critical' : 'text-xs text-ink-tertiary'}>
        Cloudflare 在账户超过 50 个 zone 且等待生效的多于已生效时禁止新增；等待额度与天数见「系统设置 · 域名托管」。
      </p>
    </section>
  );
}

function RowActions({ domain, onAction }: { domain: HostedDomain; onAction: (action: PendingAction) => void }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" aria-label={`${domain.domain} 的更多操作`}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => navigate(detailHref(domain))}>查看详情</DropdownMenuItem>
        {domain.status === 'suspended' ? (
          <DropdownMenuItem onSelect={() => onAction({ domain, kind: 'resume' })}>恢复</DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            tone="danger"
            disabled={domain.status === 'deleting'}
            onSelect={() => onAction({ domain, kind: 'suspend' })}
          >
            暂停
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DomainLink({ domain }: { domain: HostedDomain }) {
  return (
    <Link to={detailHref(domain)} className="truncate font-medium text-ink hover:text-accent hover:underline">
      {domain.domain}
    </Link>
  );
}

export function AdminHostedDomainsPage() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<HostedDomainStatus | typeof ALL_STATUSES>(ALL_STATUSES);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim().toLowerCase(), 250);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const filters = { status: status === ALL_STATUSES ? undefined : status, q: debounced || undefined };
  const {
    data, isLoading, isError, error, refetch, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.admin.hostedDomainList(filters),
    queryFn: ({ pageParam }) => adminHostedDomainApi.list(filters, pageParam, PAGE_SIZE),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  const filtered = status !== ALL_STATUSES || debounced !== '';

  const act = useMutation({
    mutationFn: ({ domain, kind }: PendingAction) =>
      kind === 'suspend' ? adminHostedDomainApi.suspend(domain.id) : adminHostedDomainApi.resume(domain.id),
    onSuccess: (updated, { kind }) => {
      // 各列表已就地替换；只有按状态筛选的列表可能因此移出这一行，只重拉这些
      storeHostedDomain(queryClient, updated);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.hostedDomains,
        predicate: (query) => Boolean((query.queryKey[2] as { status?: string } | undefined)?.status),
      });
      toast({ title: kind === 'suspend' ? `已暂停 ${updated.domain}` : `已恢复 ${updated.domain}`, variant: 'success' });
      setPendingAction(null);
    },
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '操作失败，请重试', variant: 'error' }),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="托管域名"
        description="用户把自己的域名托管到本站，名称服务器生效后自动开通收件与发信。管理员可进入详情管理任意域名。"
      />

      <HealthCard />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <Input
            aria-label="搜索托管域名"
            value={search}
            maxLength={253}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索域名或所有者"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as HostedDomainStatus | typeof ALL_STATUSES)}>
          <SelectTrigger aria-label="按状态筛选" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES}>全部状态</SelectItem>
            {HOSTED_DOMAIN_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : isError && items.length === 0 ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Network}
          title={filtered ? '没有符合条件的托管域名' : '还没有用户托管域名'}
          description={filtered ? '换个状态或关键词再试。' : '用户在「我的域名」添加域名后会出现在这里。'}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {items.map((domain) => (
            <CardListItem
              key={domain.id}
              title={<DomainLink domain={domain} />}
              subtitle={`所有者：${domain.ownerUsername}`}
              meta={
                <>
                  <HostedDomainStatusBadge status={domain.status} />
                  <span>成员 {domain.memberCount}</span>
                  <span>地址 {domain.mailboxCount}</span>
                  <span>添加于 {formatDateTime(domain.createdAt)}</span>
                </>
              }
              actions={<RowActions domain={domain} onAction={setPendingAction} />}
            />
          ))}
        </CardList>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>域名</TableHead>
              <TableHead>所有者</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>成员数</TableHead>
              <TableHead>地址数</TableHead>
              <TableHead>添加时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((domain) => (
              <TableRow key={domain.id}>
                <TableCell>
                  <DomainLink domain={domain} />
                </TableCell>
                <TableCell className="text-ink-secondary">{domain.ownerUsername}</TableCell>
                <TableCell>
                  <HostedDomainStatusBadge status={domain.status} />
                </TableCell>
                <TableCell className="text-ink-secondary">{domain.memberCount}</TableCell>
                <TableCell className="text-ink-secondary">{domain.mailboxCount}</TableCell>
                <TableCell className="text-ink-tertiary">{formatDateTime(domain.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <RowActions domain={domain} onAction={setPendingAction} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {items.length > 0 &&
        (isError ? (
          <QueryErrorState error={error} onRetry={() => void (isFetchNextPageError ? fetchNextPage() : refetch())} />
        ) : (
          <LoadMoreFooter hasNextPage={hasNextPage} isFetchingNextPage={isFetchingNextPage} onLoadMore={loadMore} />
        ))}

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(next) => !next && !act.isPending && setPendingAction(null)}
        title={
          pendingAction?.kind === 'suspend' ? `暂停 ${pendingAction.domain.domain}？` : `恢复 ${pendingAction?.domain.domain ?? ''}？`
        }
        description={
          pendingAction?.kind === 'suspend'
            ? '暂停后该域名拒收来信，禁止发信和新认领；已有地址与邮件保留，可随时恢复。'
            : '恢复后立即按 Cloudflare 的实际状态重新核对，名称服务器仍指向本站时恢复收发与认领。'
        }
        confirmLabel={pendingAction?.kind === 'suspend' ? '暂停' : '恢复'}
        tone={pendingAction?.kind === 'suspend' ? 'danger' : 'default'}
        loading={act.isPending}
        onConfirm={() => pendingAction && act.mutate(pendingAction)}
      />
    </div>
  );
}
