import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Power, ScrollText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ApiKeyStatus, ApiKeySummary } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { apiKeyApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useCurrentUser } from '@/lib/use-session';
import { AuditLogDialog } from './audit-log-dialog';
import { CreateApiKeyDialog } from './create-api-key-dialog';

const STATUS_META: Record<ApiKeyStatus, { label: string; tone: BadgeTone }> = {
  active: { label: '启用', tone: 'positive' },
  disabled: { label: '停用', tone: 'neutral' },
  revoked: { label: '已吊销', tone: 'critical' },
};

export function ApiKeysPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const [view, setView] = useState<'mine' | 'all'>('mine');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ApiKeySummary | null>(null);
  const [auditKey, setAuditKey] = useState<ApiKeySummary | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.apiKeys.list(view === 'all' ? 'admin' : 'mine'),
    queryFn: () => (view === 'all' ? apiKeyApi.listAll() : apiKeyApi.list()),
  });

  const toggleStatus = useMutation({
    mutationFn: (key: ApiKeySummary) =>
      apiKeyApi.update(key.id, { status: key.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.root }),
    onError: () => toast({ title: '操作失败，请重试', variant: 'error' }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiKeyApi.remove(id),
    onSuccess: () => {
      toast({ title: '密钥已删除', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.root });
      setDeleting(null);
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const items = data ?? [];
  const editable = view === 'mine';

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="API Keys"
        description="用于开放 API（/v1）的访问凭证，创建后仅展示一次完整密钥。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            创建密钥
          </Button>
        }
      />

      {isAdmin && (
        <div className="mb-4">
          <SegmentedControl
            aria-label="密钥范围"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'mine', label: '我的密钥' },
              { value: 'all', label: '全站密钥' },
            ]}
          />
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="还没有 API 密钥"
          description="创建一个密钥以通过开放 API 访问邮箱。"
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              {view === 'all' && <TableHead>所属用户</TableHead>}
              <TableHead>密钥</TableHead>
              <TableHead>权限</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((key) => {
              const status = STATUS_META[key.status];
              return (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  {view === 'all' && <TableCell className="text-ink-secondary">{key.ownerUsername ?? '—'}</TableCell>}
                  <TableCell>
                    <code className="font-mono text-xs text-ink-secondary">
                      {key.keyPrefix}…{key.keySuffix}
                    </code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} tone="neutral">
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TableCell>
                  <TableCell className="text-ink-tertiary" title={key.lastUsedAt ? formatDateTime(key.lastUsedAt) : ''}>
                    {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : '从未'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setAuditKey(key)}>
                        <ScrollText className="size-4" />
                        审计日志
                      </Button>
                      {editable && (
                        <>
                          <IconButton
                            size="sm"
                            aria-label={key.status === 'active' ? '停用' : '启用'}
                            disabled={key.status === 'revoked' || toggleStatus.isPending}
                            onClick={() => toggleStatus.mutate(key)}
                          >
                            <Power className="size-4" />
                          </IconButton>
                          <IconButton size="sm" aria-label="删除密钥" onClick={() => setDeleting(key)}>
                            <Trash2 className="size-4 text-critical" />
                          </IconButton>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AuditLogDialog apiKey={auditKey} onClose={() => setAuditKey(null)} admin={view === 'all'} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title="删除这个密钥？"
        description={deleting ? `删除 “${deleting.name}” 后使用它的调用将立即失效。` : undefined}
        confirmLabel="删除"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
