import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { NotificationDeliveryView } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { notifyPrefsApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

const CHANNELS = { feishu: '飞书', pushdeer: 'PushDeer', webhook: 'Webhook', forward: '邮箱转发' };
const STATUSES = { pending: '等待重试', processing: '处理中', succeeded: '投递成功', failed: '投递失败', skipped: '已跳过', unknown: '结果未确认' };

export function NotificationHealthPanel() {
  const health = useQuery({ queryKey: queryKeys.notificationHealth, queryFn: () => notifyPrefsApi.health(), refetchInterval: 30_000 });
  const [retrying, setRetrying] = useState<NotificationDeliveryView | null>(null);
  const retry = useMutation({
    mutationFn: (id: number) => notifyPrefsApi.retry(id),
    onSuccess: () => { setRetrying(null); void health.refetch(); toast({ title: '通知已重新排队', variant: 'success' }); },
    onError: (error) => toast({ title: error instanceof Error ? error.message : '重试失败', variant: 'error' }),
  });
  return <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-ink">最近通知与转发结果</h2>
      <Button variant="ghost" size="sm" loading={health.isFetching} onClick={() => void health.refetch()}>刷新结果</Button>
    </div>
    {health.isPending ? <Skeleton className="h-24 w-full" /> : health.isError ? <QueryErrorState error={health.error} onRetry={() => void health.refetch()} /> : <>
      <ul className="flex flex-col gap-2">
        {health.data.channels.map((channel) => {
          const latest = channel.latest;
          const failure = latest && ['failed', 'unknown'].includes(latest.status);
          return <li key={channel.channel} className="rounded-md border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{CHANNELS[channel.channel]}</span>
              <Badge tone={failure ? 'critical' : latest?.status === 'succeeded' ? 'positive' : 'neutral'}>{latest ? STATUSES[latest.status] : '尚无投递记录'}</Badge>
              {!channel.enabled && <span className="text-xs text-ink-tertiary">已关闭</span>}
              <span className="text-xs text-ink-tertiary">待处理 {channel.pendingCount}，失败或未确认 {channel.failedCount}</span>
            </div>
            {latest && <div className="mt-1 space-y-1 text-xs text-ink-secondary">
              <p>{formatDateTime(latest.updatedAt)}，已尝试 {latest.attempts}/{latest.maxAttempts} 次{latest.target ? `，目标 ${latest.target}` : ''}{latest.lastHttpStatus ? `，HTTP ${latest.lastHttpStatus}` : ''}</p>
              {latest.lastError && <p className="break-words">{latest.lastError}</p>}
              {latest.status === 'pending' && <p>下次尝试：{formatDateTime(latest.nextAttemptAt)}</p>}
              {failure && latest.messageId !== null && channel.channel !== 'forward' && channel.enabled && <Button size="sm" variant="secondary" onClick={() => setRetrying(latest)}>重试通知</Button>}
              {failure && channel.channel === 'forward' && <p>先确认目标邮箱的收件情况，再从原邮件手动转发。</p>}
            </div>}
          </li>;
        })}
      </ul>
      <div className="border-t border-line pt-3 text-xs text-ink-secondary">
        <p>转发按 UTC 天计量尝试次数：每个收件域名 {health.data.forward.domainLimit} 次，每个转发目标 {health.data.forward.targetLimit} 次。同一域名或目标由所有用户共享配额；尝试次数并非成功数。</p>
        <p className="mt-1">计量窗口结束：{formatDateTime(health.data.forward.windowEndsAt)}</p>
        {[...health.data.forward.domains.map((domain) => ({ name: domain.domain, ...domain })), ...health.data.forward.targets.map((target) => ({ name: target.address, ...target }))].map((usage) => <p key={usage.name} className="mt-1 break-words">{usage.name}：尝试 {usage.attempts}，剩余 {usage.remaining}</p>)}
      </div>
    </>}
    <ConfirmDialog open={retrying !== null} onOpenChange={(open) => !open && setRetrying(null)} title="重新推送通知？" description={retrying?.status === 'unknown' ? '上次投递结果未确认，请先检查目标服务。再次推送可能收到重复通知。' : '将使用当前已保存的配置重试该邮件通知。'} confirmLabel="重新推送" loading={retry.isPending} onConfirm={() => retrying && retry.mutate(retrying.id)} />
  </section>;
}
