import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, CircleCheck, Eye, EyeOff, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreateSystemDomainOnboardingRequest,
  SystemDomainOnboardingSummary,
  SystemDomainPrecheck,
  SystemDomainZone,
  SystemDomainZonesView,
} from '@hpc-mail/shared';
import { ApiError, errorMessage } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { AddExternalDomainDialog } from './add-external-domain-dialog';
import { OnboardConfirmDialog } from './onboard-confirm-dialog';
import { OnboardingProgress, OnboardingStateBadge, registrarLabel } from './system-domain-meta';
import { storeOnboarding, systemDomainApi, systemDomainKeys, useActiveOnboardingsPolling, useSystemDomainZones } from './system-domains-api';


/** 接入失败或被阻断时的说明；删除 MX 后路由未开启要红字提示 */
function TaskError({ task }: { task: SystemDomainOnboardingSummary }) {
  if (!task.lastError) return null;
  const urgent = task.errorCode === 'mx_removed_routing_pending';
  return (
    <p className={cn('text-xs', urgent || task.state === 'blocked' ? 'text-critical' : 'text-ink-tertiary')}>
      {urgent && <b>MX 已删除，路由尚未开启：该域名暂时收不到信，系统会尽快重试。</b>}
      {urgent ? '' : task.lastError}
    </p>
  );
}

function TaskLine({ task, onCheck, checking }: { task: SystemDomainOnboardingSummary; onCheck: () => void; checking: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <OnboardingStateBadge state={task.state} />
        <OnboardingProgress task={task} />
      </div>
      <TaskError task={task} />
      <div className="flex flex-wrap items-center gap-1.5">
        {task.state === 'needs_confirmation' ? (
          <Button asChild size="sm" variant="primary">
            <Link to={`/admin/domains/onboarding/${task.id}`}>去确认</Link>
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={checking} onClick={onCheck}>
            {task.state === 'blocked' ? '重试' : '立即检测'}
          </Button>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link to={`/admin/domains/onboarding/${task.id}`}>详情</Link>
        </Button>
      </div>
    </div>
  );
}

function Readiness({ zone }: { zone: SystemDomainZone }) {
  const readiness = zone.readiness;
  if (!readiness) return null;
  const reasons = readiness.reasons.join('；');
  switch (readiness.verdict) {
    case 'ready':
      return <span className="flex items-center gap-1 text-xs text-positive"><CircleCheck aria-hidden className="size-3.5" />可直接接入</span>;
    case 'confirm':
      return <span className="text-xs text-caution">需确认 {readiness.confirmCount} 项{reasons ? `：${reasons}` : ''}</span>;
    case 'blocked':
      return <span className="text-xs text-critical">无法接入{reasons ? `：${reasons}` : ''}</span>;
    case 'pending':
      return <span className="text-xs text-ink-secondary">等待 Cloudflare 激活（接入后生效即自动继续）</span>;
    default:
      return <span className="text-xs text-ink-tertiary">未检查，点「接入」时检查</span>;
  }
}

interface ZoneRowProps {
  zone: SystemDomainZone;
  busy: boolean;
  checking: boolean;
  onOnboard: () => void;
  onView: () => void;
  onToggleHidden: () => void;
  onCheck: (id: number) => void;
}

function ZoneRow({ zone, busy, checking, onOnboard, onView, onToggleHidden, onCheck }: ZoneRowProps) {
  const blocked = zone.readiness?.verdict === 'blocked';
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{zone.name}</span>
          {zone.readiness?.registrar && <Badge>{registrarLabel(zone.readiness.registrar)}</Badge>}
          {zone.status !== 'active' && <Badge tone="caution">Cloudflare：{zone.status}</Badge>}
          {zone.hidden && <Badge>已隐藏</Badge>}
        </div>
        {!zone.onboarding && (
          <div className="flex shrink-0 items-center gap-1.5">
            {blocked ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={onView}>查看</Button>
            ) : (
              <Button size="sm" variant="primary" loading={busy} disabled={busy} onClick={onOnboard} aria-label={`接入 ${zone.name}`}>
                {zone.readiness?.verdict === 'confirm' ? '接入…' : '接入'}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onToggleHidden} aria-label={`${zone.hidden ? '恢复显示' : '隐藏'} ${zone.name}`}>
              {zone.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              {zone.hidden ? '恢复' : '隐藏'}
            </Button>
          </div>
        )}
      </div>
      {zone.onboarding
        ? <TaskLine task={zone.onboarding} checking={checking} onCheck={() => onCheck(zone.onboarding!.id)} />
        : <Readiness zone={zone} />}
    </li>
  );
}

const OTHER_LABEL: Record<string, string> = { system: '已是系统域名', hosted: '用户托管', inconsistent: '托管记录不一致', onboarding: '接入中', available: '可接入' };

function OthersSection({ view }: { view: SystemDomainZonesView }) {
  const [open, setOpen] = useState(false);
  if (view.others.length === 0) return null;
  const { counts } = view;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between gap-2 text-left text-xs text-ink-tertiary hover:text-ink-secondary"
      >
        <span>
          已是系统域名 {counts.system} 个、用户托管 {counts.hosted} 个（其中管理员名下 {counts.hostedByAdmin} 个）不在此列
          {counts.inconsistent > 0 && `，${counts.inconsistent} 个托管记录与 zone 不一致`}，可展开查看
        </span>
        <ChevronDown aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="flex flex-col gap-1 text-xs">
          {view.others.map((zone) => (
            <li key={zone.zoneId} className="flex flex-wrap items-center gap-2 text-ink-secondary">
              <span className="text-ink">{zone.name}</span>
              <Badge tone={zone.category === 'inconsistent' ? 'critical' : 'neutral'}>
                {zone.category === 'hosted' && zone.owner?.isAdmin ? '管理员名下托管' : OTHER_LABEL[zone.category]}
              </Badge>
              {zone.owner && <span>所有者 {zone.owner.username}</span>}
              {zone.category === 'inconsistent' && <span className="text-critical">托管记录的 zone 与账户中的不一致，请核对</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 收件域名页的主路径：列出站长 Cloudflare 账户中可接入的 zone，每行一个「接入」按钮一键完成；
 * 进行中的任务直接显示在对应行上。只在 Worker 配有 Cloudflare 凭据时显示。
 */
export function CloudflareZonesCard() {
  const queryClient = useQueryClient();
  const [showHidden, setShowHidden] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dialog, setDialog] = useState<{ precheck: SystemDomainPrecheck; readOnly: boolean } | null>(null);
  const [busyZone, setBusyZone] = useState<string | null>(null);
  const zonesQuery = useSystemDomainZones(showHidden);
  const view = zonesQuery.data;
  useActiveOnboardingsPolling(queryClient, view, showHidden);

  // 任务从列表里消失（完成或取消）时，上方系统域名列表可能变了
  const activeIds = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!view || showHidden) return;
    const now = new Set([...view.zones.flatMap((zone) => (zone.onboarding ? [zone.onboarding.id] : [])), ...view.unlistedTasks.map((task) => task.id)]);
    const before = activeIds.current;
    activeIds.current = now;
    if (before && [...before].some((id) => !now.has(id))) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.config });
    }
  }, [view, showHidden, queryClient]);

  const create = useMutation({
    mutationFn: (body: CreateSystemDomainOnboardingRequest) => systemDomainApi.create(body),
    onSuccess: (task) => {
      storeOnboarding(queryClient, task);
      setDialog(null);
      toast({ title: task.state === 'awaiting_ns' ? `${task.domain} 已关联，等待 Cloudflare 激活` : `开始接入 ${task.domain}`, variant: 'success' });
    },
    onError: (error) => {
      const precheck = error instanceof ApiError ? error.details?.precheck : undefined;
      if (precheck) {
        setDialog({ precheck, readOnly: precheck.verdict === 'blocked' });
        if (precheck.verdict !== 'blocked' && dialog) toast({ title: 'Cloudflare 上的配置已变化，请重新核对后确认', variant: 'error' });
        return;
      }
      toast({ title: errorMessage(error, '接入失败，请重试'), variant: 'error' });
    },
    onSettled: () => setBusyZone(null),
  });

  const precheck = useMutation({
    mutationFn: (zoneId: string) => systemDomainApi.precheck({ mode: 'existing_zone', zoneId }),
    onError: (error) => {
      setBusyZone(null);
      toast({ title: errorMessage(error, '检查失败，请重试'), variant: 'error' });
    },
  });

  const onboard = async (zone: SystemDomainZone) => {
    setBusyZone(zone.zoneId);
    const verdict = zone.readiness?.verdict;
    if (verdict === 'ready' || verdict === 'pending') {
      create.mutate({ mode: 'existing_zone', zoneId: zone.zoneId });
      return;
    }
    const result = await precheck.mutateAsync(zone.zoneId).catch(() => null);
    if (!result) return;
    if (result.verdict === 'ready' || result.verdict === 'pending') {
      create.mutate({ mode: 'existing_zone', zoneId: zone.zoneId, fingerprint: result.fingerprint });
      return;
    }
    setBusyZone(null);
    setDialog({ precheck: result, readOnly: result.verdict === 'blocked' });
  };

  const viewBlocked = async (zone: SystemDomainZone) => {
    setBusyZone(zone.zoneId);
    const result = await precheck.mutateAsync(zone.zoneId).catch(() => null);
    setBusyZone(null);
    if (result) setDialog({ precheck: result, readOnly: true });
  };

  const hide = useMutation({
    mutationFn: (zone: SystemDomainZone) =>
      systemDomainApi.setHidden({ domain: zone.name, hidden: !zone.hidden, expectedRevision: view?.hiddenRevision ?? 0 }),
    onSuccess: (_, zone) => {
      toast({ title: zone.hidden ? `已恢复显示 ${zone.name}` : `已隐藏 ${zone.name}`, variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: systemDomainKeys.zonesRoot });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: systemDomainKeys.zonesRoot });
      toast({ title: error instanceof ApiError && error.httpStatus === 409 ? '隐藏列表已被其他操作更新，请重试' : errorMessage(error, '操作失败'), variant: 'error' });
    },
  });

  const check = useMutation({
    mutationFn: (id: number) => systemDomainApi.check(id),
    onSuccess: (task) => storeOnboarding(queryClient, task),
    onError: (error) => toast({ title: errorMessage(error, '检测失败，请稍后重试'), variant: 'error' }),
  });

  const refresh = useMutation({
    mutationFn: () => systemDomainApi.zones(showHidden, true),
    onSuccess: (fresh) => queryClient.setQueryData(systemDomainKeys.zones(showHidden), fresh),
    onError: (error) => toast({ title: errorMessage(error, '刷新失败，请稍后重试'), variant: 'error' }),
  });

  if (zonesQuery.isLoading) return <Skeleton className="h-28 w-full rounded-lg" />;
  if (zonesQuery.isError) {
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold text-ink">Cloudflare 中可接入的域名</h2>
        <QueryErrorState error={zonesQuery.error} onRetry={() => void zonesQuery.refetch()} />
      </section>
    );
  }
  if (!view?.configured) return null;

  const checkingId = check.isPending ? check.variables : null;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5" aria-label="Cloudflare 中可接入的域名">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Cloudflare 中可接入的域名</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            站长 Cloudflare 账户里还没接入本站的域名。点「接入」自动开启收件路由、catch-all 与发信，完成后加入上方列表（默认仅管理员可用）。
            完成前到达的来信会按「未认领」收下。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? '返回可接入列表' : `显示已隐藏${view.counts.hidden ? `（${view.counts.hidden}）` : ''}`}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            添加不在 Cloudflare 的域名
          </Button>
        </div>
      </div>

      {!view.complete && (
        <p className="flex items-center gap-1.5 text-xs text-caution">
          <AlertTriangle aria-hidden className="size-3.5" />
          账户中的 zone 太多，只列出了前一部分。
        </p>
      )}

      {view.zones.length + view.unlistedTasks.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-tertiary">
          {showHidden ? '没有已隐藏的域名' : '账户里暂时没有可接入的域名'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.zones.map((zone) => (
            <ZoneRow
              key={zone.zoneId}
              zone={zone}
              busy={busyZone === zone.zoneId || (hide.isPending && hide.variables?.zoneId === zone.zoneId)}
              checking={zone.onboarding !== null && checkingId === zone.onboarding.id}
              onOnboard={() => void onboard(zone)}
              onView={() => void viewBlocked(zone)}
              onToggleHidden={() => hide.mutate(zone)}
              onCheck={(id) => check.mutate(id)}
            />
          ))}
          {view.unlistedTasks.map((task) => (
            <li key={`task-${task.id}`} className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
              <span className="text-sm font-medium text-ink">{task.domain}</span>
              <TaskLine task={task} checking={checkingId === task.id} onCheck={() => check.mutate(task.id)} />
            </li>
          ))}
        </ul>
      )}

      {!showHidden && <OthersSection view={view} />}

      <OnboardConfirmDialog
        open={dialog !== null}
        precheck={dialog?.precheck ?? null}
        readOnly={dialog?.readOnly ?? false}
        pending={create.isPending}
        onOpenChange={(open) => !open && setDialog(null)}
        onConfirm={({ fingerprint, accept }) => {
          if (!dialog?.precheck.zoneId) return;
          setBusyZone(dialog.precheck.zoneId);
          create.mutate({ mode: 'existing_zone', zoneId: dialog.precheck.zoneId, fingerprint, accept });
        }}
      />
      <AddExternalDomainDialog open={addOpen} onOpenChange={setAddOpen} />
    </section>
  );
}
