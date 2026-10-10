import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AdminAuditLogEntry } from '@hpc-mail/shared';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { useIsMobile } from '@/lib/use-media-query';

const ACTION_META: Record<string, { label: string; tone: BadgeTone }> = {
  'user.create': { label: '创建用户', tone: 'positive' },
  'user.update': { label: '修改用户', tone: 'neutral' },
  'user.delete': { label: '删除用户', tone: 'critical' },
  'settings.update': { label: '修改设置', tone: 'caution' },
  'invite.create': { label: '生成邀请码', tone: 'neutral' },
  'invite.revoke': { label: '作废邀请码', tone: 'neutral' },
  'apikey.revoke': { label: '吊销密钥', tone: 'critical' },
  'mailbox.transfer': { label: '过户邮箱', tone: 'caution' },
  'mailbox.share': { label: '共享邮箱', tone: 'neutral' },
  'mailbox.unshare': { label: '取消共享', tone: 'neutral' },
};

const ALL_ACTIONS = 'all';

function actionMeta(action: string): { label: string; tone: BadgeTone } {
  return ACTION_META[action] ?? { label: action, tone: 'neutral' };
}

/** 客户端筛选已加载的审计记录：操作类型精确匹配 + 操作人/目标/详情/IP 关键字 */
export function filterAuditLogs(logs: AdminAuditLogEntry[], action: string, keyword: string): AdminAuditLogEntry[] {
  const term = keyword.trim().toLowerCase();
  return logs.filter((log) => {
    if (action !== ALL_ACTIONS && log.action !== action) return false;
    if (!term) return true;
    return [log.actorName, log.target, log.detail, log.ip].some((field) => field.toLowerCase().includes(term));
  });
}

export function AuditPage() {
  const isMobile = useIsMobile();
  const [action, setAction] = useState(ALL_ACTIONS);
  const [keyword, setKeyword] = useState('');
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['admin', 'audit-logs'],
    queryFn: ({ pageParam }) => adminApi.auditLogs(pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const logs = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const actionOptions = useMemo(() => {
    const known = Object.keys(ACTION_META);
    const unknown = [...new Set(logs.map((log) => log.action))].filter((item) => !known.includes(item)).sort();
    return [...known, ...unknown];
  }, [logs]);
  const filtered = useMemo(() => filterAuditLogs(logs, action, keyword), [logs, action, keyword]);
  const filtering = action !== ALL_ACTIONS || keyword.trim() !== '';

  const clearFilters = () => {
    setAction(ALL_ACTIONS);
    setKeyword('');
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="操作审计" description="管理员的高危操作记录（删户、改密、改设置、邀请、吊销密钥、过户与共享等）。" />
      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : logs.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="暂无审计记录"
          description="管理员执行敏感操作后会记录在这里。"
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-48">
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger aria-label="按操作类型筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_ACTIONS}>全部操作</SelectItem>
                  {actionOptions.map((item) => (
                    <SelectItem key={item} value={item}>
                      {actionMeta(item).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
              <Input
                aria-label="搜索操作人、目标或详情"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索操作人、目标或详情"
                className="pl-9"
              />
            </div>
          </div>
          {filtering && (
            <p className="mb-3 text-xs text-ink-tertiary">
              仅筛选已加载的 {logs.length} 条记录，匹配 {filtered.length} 条
              {hasNextPage ? '；更早的记录请点击下方「加载更多」后再筛选。' : '。'}
            </p>
          )}

          {filtered.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="没有匹配的记录"
              description="换个操作类型或关键字试试。"
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              }
              className="rounded-lg border border-line bg-surface"
            />
          ) : isMobile ? (
            <CardList>
              {filtered.map((log) => {
                const meta = actionMeta(log.action);
                return (
                  <CardListItem
                    key={log.id}
                    title={
                      <>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="truncate">{log.actorName}</span>
                      </>
                    }
                    subtitle={log.target || undefined}
                    meta={
                      <>
                        <span>{formatDateTime(log.createdAt)}</span>
                        {log.ip && <span className="font-mono">{log.ip}</span>}
                        {log.detail && (
                          <span className="basis-full whitespace-pre-wrap break-words text-ink-secondary">{log.detail}</span>
                        )}
                      </>
                    }
                  />
                );
              })}
            </CardList>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>操作人</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>目标</TableHead>
                  <TableHead>详情</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((log) => {
                  const meta = actionMeta(log.action);
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-ink-tertiary">
                        {formatDateTime(log.createdAt)}
                      </TableCell>
                      <TableCell className="font-medium text-ink">{log.actorName}</TableCell>
                      <TableCell>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="break-all text-ink-secondary">{log.target || '—'}</TableCell>
                      <TableCell className="min-w-48 max-w-sm whitespace-pre-wrap break-words text-ink-secondary">
                        {log.detail || '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-ink-tertiary">{log.ip || '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {hasNextPage && (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
