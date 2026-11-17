import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  SYSTEM_DOMAIN_STEP_KEYS,
  type SystemDomainOnboarding,
  type SystemDomainPrecheck,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { OnboardConfirmDialog } from './onboard-confirm-dialog';
import { CheckDetail, DNSSEC_LABEL, OnboardingStateBadge, STEP_LABEL } from './system-domain-meta';
import { storeOnboarding, systemDomainApi, systemDomainKeys, useSystemDomainOnboarding } from './system-domains-api';

const TERMINAL = new Set(['completed', 'cancelled', 'failed']);
const STEP_STATE_LABEL: Record<string, { label: string; className: string }> = {
  ready: { label: '已就绪', className: 'text-positive' },
  waiting: { label: '等待中', className: 'text-ink-tertiary' },
  missing: { label: '待写入', className: 'text-ink-tertiary' },
  unknown: { label: '未知', className: 'text-ink-tertiary' },
  conflict: { label: '有冲突', className: 'text-caution' },
  error: { label: '失败', className: 'text-critical' },
};
const CHANGE_LABEL: Record<string, string> = {
  'zone.create': '创建 zone', 'zone.delete': '删除 zone', 'spf.merge': '合并 SPF', 'catchAll.put': '配置 catch-all',
  'mx.delete': '删除第三方 MX', 'routing.enable': '开启收件路由', 'sending.create': '接入发信', 'sending.repair': '补写发信记录',
};
const CHANGE_STATUS: Record<string, string> = { started: '进行中', done: '完成', unknown: '结果不明', failed: '失败' };

/** 只有 404 当作不存在；403 是权限或凭据问题，要提示而不是跳走 */
const isGone = (error: unknown) => error instanceof ApiError && (error.httpStatus === 404 || error.code === 'not_found');
const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function CancelDialog({ task, open, onOpenChange }: { task: SystemDomainOnboarding; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  // 本次创建、从未激活的 zone 默认勾选删除，释放 pending 额度
  const [deleteZone, setDeleteZone] = useState(true);
  const cancel = useMutation({
    mutationFn: () => systemDomainApi.cancel(task.id, { deleteCreatedZone: task.canDeleteZone && deleteZone }),
    onSuccess: (next) => {
      storeOnboarding(queryClient, next);
      onOpenChange(false);
      toast({ title: next.state === 'cancelled' ? '已取消接入' : '正在取消', variant: 'success' });
    },
    onError: (error) => toast({ title: errorMessage(error, '取消失败，请重试'), variant: 'error' }),
  });
  const touched = task.changes.some((change) => change.kind !== 'zone.create' && (change.status === 'done' || change.status === 'unknown'));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader title={`取消接入 ${task.domain}？`} />
        <DialogBody className="flex flex-col gap-3 text-sm text-ink-secondary">
          <p>取消后不再检测或写入 Cloudflare。已经做过的修改不会自动回滚，原值见下方变更台账。</p>
          {touched && (
            <p className="text-caution">catch-all 若已指向本站，这个域名的来信会继续按「未认领」进入本站；如需停止，请在 Cloudflare 恢复原规则。</p>
          )}
          {task.canDeleteZone && (
            <label className="flex cursor-pointer items-start gap-2">
              <Checkbox checked={deleteZone} onCheckedChange={(value) => setDeleteZone(value === true)} aria-label="同时删除本次创建、未生效的 zone" className="mt-0.5" />
              <span>同时删除本次创建、未生效的 zone（释放 Cloudflare 的待激活额度）</span>
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={cancel.isPending}>返回</Button>
          <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>取消接入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 接入任务详情：NS、分项状态、待确认项、立即检测、取消与变更台账 */
export function OnboardingDetailPage() {
  const id = Number(useParams().id);
  const queryClient = useQueryClient();
  const query = useSystemDomainOnboarding(id);
  const task = query.data;
  const [confirming, setConfirming] = useState<SystemDomainPrecheck | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const check = useMutation({
    mutationFn: () => systemDomainApi.check(id),
    onSuccess: (next) => storeOnboarding(queryClient, next),
    onError: (error) => toast({ title: errorMessage(error, '检测失败，请稍后重试'), variant: 'error' }),
  });
  const confirm = useMutation({
    mutationFn: (body: { fingerprint: string; accept: SystemDomainOnboarding['accepted'] }) => systemDomainApi.confirm(id, body),
    onSuccess: (next) => {
      storeOnboarding(queryClient, next);
      setConfirming(null);
      toast({ title: '已确认，继续接入', variant: 'success' });
    },
    onError: (error) => {
      const fresh = error instanceof ApiError ? error.details?.precheck : undefined;
      if (fresh) {
        // 指纹过期：用最新预检刷新确认框，需要重新逐项确认
        setConfirming(fresh);
        void queryClient.invalidateQueries({ queryKey: systemDomainKeys.onboarding(id) });
        toast({ title: 'Cloudflare 上的配置已变化，请重新核对后确认', variant: 'error' });
        return;
      }
      toast({ title: errorMessage(error, '确认失败，请重试'), variant: 'error' });
    },
  });

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to="/admin/domains"><ArrowLeft className="size-4" />收件域名</Link>
    </Button>
  );

  if (query.isLoading) return <div className="mx-auto max-w-2xl"><Skeleton className="h-64 w-full rounded-lg" /></div>;
  if (query.isError || !task) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {back}
        {!query.isError || isGone(query.error)
          ? <EmptyState title="接入任务不存在" description="可能是链接有误。" className="rounded-lg border border-dashed border-line" />
          : <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />}
      </div>
    );
  }

  const active = !TERMINAL.has(task.state);
  const confirmItems = task.precheck?.checks.filter((item) => item.severity === 'confirm' || item.severity === 'blocker') ?? [];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      {back}
      <PageHeader
        title={task.domain}
        description={task.mode === 'new_zone' ? '新建 zone 并修改 NS 接入' : '使用 Cloudflare 账户中已有的 zone 接入'}
        actions={<OnboardingStateBadge state={task.state} />}
      />

      {task.lastError && (
        <p className={cn('flex items-start gap-1.5 rounded-md border px-3 py-2 text-[13px]',
          task.state === 'blocked' || task.state === 'failed' || task.errorCode === 'mx_removed_routing_pending'
            ? 'border-critical/40 bg-critical-soft/40 text-critical' : 'border-line text-ink-secondary')}
        >
          <AlertTriangle aria-hidden className="mt-[2px] size-3.5 shrink-0" />
          <span>
            {task.errorCode === 'mx_removed_routing_pending' && <b>MX 已删除，路由尚未开启：该域名暂时收不到信。</b>}
            {task.lastError}
          </span>
        </p>
      )}

      {(task.mode === 'new_zone' || task.state === 'awaiting_ns') && (
        <Section title="名称服务器（NS）">
          {task.nameServers.length > 0 ? (
            <>
              <p className="text-[13px] text-ink-secondary">到注册商把 {task.domain} 的 NS 改为：</p>
              <ul className="flex flex-col gap-1.5">
                {task.nameServers.map((ns) => (
                  <li key={ns} className="flex items-center gap-2">
                    <code className="rounded-sm bg-surface-active px-2 py-1 font-mono text-xs text-ink">{ns}</code>
                    <CopyButton value={ns} label={`复制 ${ns}`} size="sm" />
                  </li>
                ))}
              </ul>
              {task.originalNameServers.length > 0 && (
                <p className="text-xs text-ink-tertiary">原 NS：{task.originalNameServers.join(' / ')}{task.originalRegistrar ? `（${task.originalRegistrar}）` : ''}</p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-ink-secondary">正在向 Cloudflare 创建 zone，结果确认后显示分配的 NS。</p>
          )}
          <p className={cn('text-xs', task.dnssec === 'off' ? 'text-ink-tertiary' : 'text-critical')}>{DNSSEC_LABEL[task.dnssec]}</p>
          {task.state === 'awaiting_ns' && <p className="text-xs text-critical">NS 生效需要时间（通常几分钟到 24 小时），生效后自动继续；改 NS 会影响整个域名的 DNS。</p>}
        </Section>
      )}

      <Section
        title="接入进度"
        actions={active && task.state !== 'needs_confirmation' ? (
          <Button size="sm" variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>
            <RefreshCw className="size-4" />
            立即检测
          </Button>
        ) : undefined}
      >
        <ul className="flex flex-col gap-2">
          {SYSTEM_DOMAIN_STEP_KEYS.map((key) => {
            const step = task.steps[key];
            const meta = STEP_STATE_LABEL[step.state] ?? STEP_STATE_LABEL.unknown!;
            return (
              <li key={key} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                <span className="w-20 shrink-0 text-ink">{STEP_LABEL[key]}</span>
                <span className={meta.className}>{meta.label}</span>
                {step.detail && <span className="text-ink-tertiary">{step.detail}</span>}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-ink-tertiary">
          {task.checkedAt ? `最近检查 ${formatRelativeTime(task.checkedAt)}` : '尚未检查'}
          {task.nextCheckAt && active ? ` · 下次自动检查 ${formatDateTime(task.nextCheckAt)}` : ''}
        </p>
        <p className="text-xs text-ink-tertiary">完成前到达的来信会按「未认领」收下，不会丢失。完成后域名默认仅管理员可认领，可在收件域名页公开。</p>
      </Section>

      {confirmItems.length > 0 && active && (
        <Section
          title={task.state === 'needs_confirmation' ? '待确认' : '检查结果'}
          actions={task.state === 'needs_confirmation' && task.precheck ? (
            <Button size="sm" onClick={() => setConfirming(task.precheck)}>确认并继续</Button>
          ) : undefined}
        >
          <ul className="flex flex-col gap-3">
            {confirmItems.map((item) => <li key={`${item.key}-${item.title}`}><CheckDetail check={item} /></li>)}
          </ul>
        </Section>
      )}

      {task.changes.length > 0 && (
        <Section title="变更台账">
          <p className="text-xs text-ink-tertiary">本站对 Cloudflare 做过的修改与原值，需要时可据此在 Cloudflare 手动恢复。</p>
          <ul className="flex flex-col gap-2 text-[13px]">
            {task.changes.map((change, index) => (
              <li key={`${change.seq}-${change.status}-${index}`} className="flex flex-col gap-0.5">
                <span className="text-ink">
                  {CHANGE_LABEL[change.kind] ?? change.kind} · {CHANGE_STATUS[change.status] ?? change.status}
                  <span className="ml-2 text-xs text-ink-tertiary">{formatDateTime(change.at)}</span>
                </span>
                {change.before && <span className="break-all font-mono text-xs text-ink-secondary">原值：{change.before}</span>}
                {change.error && <span className="text-xs text-critical">{change.error}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {task.dashboardUrl && (
          <Button asChild variant="secondary" size="sm">
            <a href={task.dashboardUrl} target="_blank" rel="noreferrer">
              在 Cloudflare 控制台查看
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        )}
        {active && !task.cancelRequested && (
          <Button variant="ghost" size="sm" className="text-critical" onClick={() => setCancelOpen(true)}>取消接入</Button>
        )}
        {task.state === 'completed' && <span className="text-xs text-ink-tertiary">移除系统域名不会停止 Cloudflare 的收件路由，如需停止请在 Cloudflare 关闭。</span>}
      </div>

      <OnboardConfirmDialog
        open={confirming !== null}
        precheck={confirming}
        pending={confirm.isPending}
        confirmLabel="确认并继续"
        onOpenChange={(open) => !open && setConfirming(null)}
        onConfirm={(body) => confirm.mutate(body)}
      />
      <CancelDialog task={task} open={cancelOpen} onOpenChange={setCancelOpen} />
    </div>
  );
}
