import { ArrowRight, CircleAlert, CircleCheck, CircleDashed, Loader2, type LucideIcon } from 'lucide-react';
import type {
  DnssecState,
  SystemDomainCheck,
  SystemDomainOnboardingState,
  SystemDomainOnboardingSummary,
  SystemDomainRegistrar,
  SystemDomainStepState,
} from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export const ONBOARDING_STATE_META: Record<SystemDomainOnboardingState, { label: string; tone: BadgeTone }> = {
  creating_zone: { label: '正在创建 zone', tone: 'accent' },
  awaiting_ns: { label: '等待 NS 生效', tone: 'caution' },
  needs_confirmation: { label: '待确认', tone: 'caution' },
  blocked: { label: '无法继续', tone: 'critical' },
  configuring: { label: '接入中', tone: 'accent' },
  finalizing: { label: '加入系统域名', tone: 'accent' },
  cancelling: { label: '正在取消', tone: 'neutral' },
  completed: { label: '已完成', tone: 'positive' },
  cancelled: { label: '已取消', tone: 'neutral' },
  failed: { label: '失败', tone: 'critical' },
};

export function OnboardingStateBadge({ state }: { state: SystemDomainOnboardingState }) {
  const meta = ONBOARDING_STATE_META[state];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function registrarLabel(registrar: SystemDomainRegistrar | null | undefined): string {
  if (!registrar || registrar.cloudflare === null) return '注册商未知';
  return registrar.cloudflare ? 'Cloudflare 购买' : '外部注册';
}

export const DNSSEC_LABEL: Record<DnssecState, string> = {
  on: 'DNSSEC 已开启：改 NS 前必须先在注册商关闭，否则域名会解析失败',
  off: 'DNSSEC 未开启',
  unknown: 'DNSSEC 检测失败（不等于未开启），改 NS 前请在注册商确认已关闭',
};

const STEP_ICON: Record<SystemDomainStepState, { icon: LucideIcon; className: string; label: string }> = {
  ready: { icon: CircleCheck, className: 'text-positive', label: '已就绪' },
  waiting: { icon: CircleDashed, className: 'text-ink-tertiary', label: '等待中' },
  missing: { icon: CircleDashed, className: 'text-ink-tertiary', label: '待写入' },
  unknown: { icon: CircleDashed, className: 'text-ink-tertiary', label: '未知' },
  conflict: { icon: CircleAlert, className: 'text-caution', label: '有冲突' },
  error: { icon: CircleAlert, className: 'text-critical', label: '失败' },
};

export const STEP_LABEL = { zone: 'zone', routing: '开启路由', catchAll: 'catch-all', sending: '发信' } as const;

/** 行内进度：开启路由 → catch-all → 发信 → 加入系统域名 */
export function OnboardingProgress({ task }: { task: Pick<SystemDomainOnboardingSummary, 'state' | 'steps'> }) {
  const running = task.state === 'configuring' || task.state === 'finalizing';
  const items: { key: string; label: string; state: SystemDomainStepState }[] = [
    { key: 'routing', label: STEP_LABEL.routing, state: task.steps.routing.state },
    { key: 'catchAll', label: STEP_LABEL.catchAll, state: task.steps.catchAll.state },
    { key: 'sending', label: STEP_LABEL.sending, state: task.steps.sending.state },
    { key: 'final', label: '加入系统域名', state: task.state === 'completed' ? 'ready' : 'waiting' },
  ];
  return (
    <ol aria-label="接入进度" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-secondary">
      {items.map((item, index) => {
        const meta = STEP_ICON[item.state];
        const spinning = running && item.state !== 'ready' && items.slice(0, index).every((prev) => prev.state === 'ready');
        const Icon = spinning ? Loader2 : meta.icon;
        return (
          <li key={item.key} className="flex items-center gap-1.5">
            {index > 0 && <ArrowRight aria-hidden className="size-3 text-ink-tertiary" />}
            <Icon aria-hidden className={cn('size-3.5', spinning ? 'animate-spin text-accent' : meta.className)} />
            <span>
              {item.label}
              <span className="sr-only">：{spinning ? '进行中' : meta.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const SEVERITY_TONE: Record<SystemDomainCheck['severity'], BadgeTone> = {
  none: 'positive', info: 'neutral', confirm: 'caution', blocker: 'critical',
};
const SEVERITY_LABEL: Record<SystemDomainCheck['severity'], string> = {
  none: '无需处理', info: '提示', confirm: '需确认', blocker: '阻断',
};

/** 预检项：现状 → 接入后、影响说明与相关记录；危险项红字 */
export function CheckDetail({ check }: { check: SystemDomainCheck }) {
  const danger = check.danger || check.severity === 'blocker';
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('font-medium', danger ? 'text-critical' : 'text-ink')}>{check.title}</span>
        <Badge tone={SEVERITY_TONE[check.severity]}>{SEVERITY_LABEL[check.severity]}</Badge>
      </div>
      {(check.current || check.proposed) && (
        <p className="break-all text-ink-secondary">
          {check.current && <span>现状：{check.current}</span>}
          {check.current && check.proposed && <span className="mx-1 text-ink-tertiary">→</span>}
          {check.proposed && <span>接入后：{check.proposed}</span>}
        </p>
      )}
      {check.impact && <p className={cn(danger ? 'text-critical' : 'text-ink-tertiary')}>{check.impact}</p>}
      {check.records.length > 0 && (
        <ul className={cn('flex flex-col gap-0.5 font-mono text-xs', check.danger ? 'text-critical' : 'text-ink-secondary')}>
          {check.records.map((record, index) => (
            <li key={`${record.type}-${record.name}-${record.content}-${index}`} className="break-all">
              {record.type} {record.name} {record.priority !== null ? `${record.priority} ` : ''}{record.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
