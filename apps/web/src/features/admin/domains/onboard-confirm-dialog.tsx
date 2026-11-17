import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SystemDomainAck, SystemDomainPrecheck } from '@hpc-mail/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { CheckDetail, registrarLabel } from './system-domain-meta';

export interface OnboardConfirmDialogProps {
  precheck: SystemDomainPrecheck | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 提交：accept 为全部勾选的需确认项，fingerprint 原样回传预检的指纹 */
  onConfirm: (input: { fingerprint: string; accept: SystemDomainAck[] }) => void;
  pending?: boolean;
  confirmLabel?: string;
  /** 只读查看（无法接入的原因、已完成的预检） */
  readOnly?: boolean;
}

/** 预检明细：阻断项、逐项勾选的需确认项、提示与将执行的步骤（确认框与「添加外部域名」共用） */
export function PrecheckReview({
  precheck,
  checked,
  onToggle,
  readOnly = false,
}: {
  precheck: SystemDomainPrecheck;
  checked: ReadonlySet<string>;
  onToggle: (ack: SystemDomainAck, next: boolean) => void;
  readOnly?: boolean;
}) {
  const checks = precheck.checks;
  const blockers = checks.filter((item) => item.severity === 'blocker');
  const confirms = checks.filter((item) => item.severity === 'confirm' && item.ack);
  const infos = checks.filter((item) => item.severity === 'info');
  return (
    <div className="flex flex-col gap-4">
      {blockers.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-critical/40 bg-critical-soft/40 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-critical">
            <AlertTriangle aria-hidden className="size-4" />
            暂时无法接入，处理以下问题后重新检测
          </p>
          <ul className="flex flex-col gap-3">
            {blockers.map((item) => (
              <li key={`${item.key}-${item.title}`}><CheckDetail check={item} /></li>
            ))}
          </ul>
        </section>
      )}
      {confirms.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">以下变更需要你逐项确认</p>
          <ul className="flex flex-col gap-3">
            {confirms.map((item) => (
              <li key={item.ack} className={cn('flex gap-3 rounded-md border p-3', item.danger ? 'border-critical/50' : 'border-line')}>
                <Checkbox
                  id={`ack-${item.ack}`}
                  aria-label={`确认：${item.title}`}
                  checked={checked.has(item.ack!)}
                  disabled={readOnly || blockers.length > 0}
                  onCheckedChange={(value) => onToggle(item.ack!, value === true)}
                  className="mt-0.5"
                />
                <label htmlFor={`ack-${item.ack}`} className="min-w-0 flex-1 cursor-pointer">
                  <CheckDetail check={item} />
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
      {infos.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">提示</p>
          <ul className="flex flex-col gap-2">
            {infos.map((item) => (
              <li key={`${item.key}-${item.title}`}><CheckDetail check={item} /></li>
            ))}
          </ul>
        </section>
      )}
      {precheck.steps.length > 0 && (
        <section className="flex flex-col gap-1 text-[13px] text-ink-secondary">
          <p className="text-sm font-medium text-ink">将依次执行</p>
          <ol className="list-decimal pl-5">
            {precheck.steps.map((step) => <li key={step.kind}>{step.detail}</li>)}
          </ol>
        </section>
      )}
    </div>
  );
}

/** 逐项勾选的状态；预检变了（指纹过期后刷新）需要重新确认 */
export function useAckSelection(precheck: SystemDomainPrecheck | null, resetKey?: unknown) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => setChecked(new Set()), [precheck?.fingerprint, resetKey]);
  const confirms = (precheck?.checks ?? []).filter((item) => item.severity === 'confirm' && item.ack);
  const blocked = (precheck?.checks ?? []).some((item) => item.severity === 'blocker');
  const toggle = (ack: SystemDomainAck, next: boolean) =>
    setChecked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(ack);
      else copy.delete(ack);
      return copy;
    });
  return {
    checked,
    toggle,
    blocked,
    danger: confirms.some((item) => item.danger),
    complete: precheck !== null && !blocked && confirms.every((item) => checked.has(item.ack!)),
    accept: confirms.map((item) => item.ack!),
  };
}

/** 接入确认框：逐项列出「现状 → 接入后」与后果，全部勾选后才能提交；有阻断项时只读说明 */
export function OnboardConfirmDialog({
  precheck,
  open,
  onOpenChange,
  onConfirm,
  pending = false,
  confirmLabel = '确认并接入',
  readOnly = false,
}: OnboardConfirmDialogProps) {
  const selection = useAckSelection(precheck, open);
  const closeOnly = readOnly || selection.blocked;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader
          title={precheck ? `接入 ${precheck.domain}` : '接入域名'}
          description={precheck ? `${registrarLabel(precheck.registrar)} · 接入后默认仅管理员可认领，可在本页调整公开范围` : undefined}
        />
        <DialogBody className="flex flex-col gap-4">
          {precheck && <PrecheckReview precheck={precheck} checked={selection.checked} onToggle={selection.toggle} readOnly={readOnly} />}
          <p className="text-xs text-ink-tertiary">
            接入完成前到达的来信会按「未认领」收下，不会丢失。本站不会自动回滚已做的修改，原值记录在接入详情的变更台账里，需要时可在 Cloudflare 手动恢复。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {closeOnly ? '关闭' : '取消'}
          </Button>
          {!closeOnly && (
            <Button
              variant={selection.danger ? 'danger' : 'primary'}
              loading={pending}
              disabled={!selection.complete || pending}
              onClick={() => precheck && onConfirm({ fingerprint: precheck.fingerprint, accept: selection.accept })}
            >
              {confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
