import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import type { ApiKeySummary } from '@hpc-mail/shared';
import { apiKeyApi } from '@/api/resources';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';

function statusTone(code: number): BadgeTone {
  if (code >= 500) return 'critical';
  if (code >= 400) return 'caution';
  return 'positive';
}

export function AuditLogDialog({
  apiKey,
  onClose,
  admin = false,
}: {
  apiKey: ApiKeySummary | null;
  onClose: () => void;
  /** admin 全站视图走 /admin 端点；自助视图走 /api-keys/:id/logs */
  admin?: boolean;
}) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['api-keys', 'logs', admin ? 'admin' : 'mine', apiKey?.id],
    queryFn: ({ pageParam }) =>
      (admin ? apiKeyApi.logs : apiKeyApi.logsMine)(apiKey!.id, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: apiKey !== null,
  });

  const logs = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Dialog open={apiKey !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader title="审计日志" description={apiKey ? `${apiKey.name} 最近的 API 调用记录` : undefined} />
        <DialogBody className="max-h-[60vh] p-0">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner className="size-6 text-ink-tertiary" />
            </div>
          ) : logs.length === 0 ? (
            <EmptyState icon={ScrollText} title="暂无调用记录" description="该密钥还没有被使用过。" />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>请求</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-ink-tertiary">
                        {formatDateTime(log.createdAt)}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-ink">
                          {log.method} {log.path}
                        </span>
                        {log.count > 1 && (
                          <span className="ml-1.5 text-xs text-ink-tertiary" title="成功的读取请求按分钟合并为一行">
                            ×{log.count}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge tone={statusTone(log.statusCode)}>{log.statusCode}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-ink-secondary">{log.ip}</TableCell>
                      <TableCell className="whitespace-nowrap text-ink-tertiary">
                        {log.count > 1 ? `平均 ${Math.round(log.durationMs / log.count)} ms` : `${log.durationMs} ms`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {hasNextPage && (
                <div className="p-3 text-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={isFetchingNextPage}
                    onClick={() => fetchNextPage()}
                  >
                    加载更多
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
