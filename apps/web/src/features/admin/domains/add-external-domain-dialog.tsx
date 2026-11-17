import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { domainSchema, type SystemDomainOnboarding, type SystemDomainPrecheck } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { PrecheckReview, useAckSelection } from './onboard-confirm-dialog';
import { DNSSEC_LABEL, registrarLabel } from './system-domain-meta';
import { storeOnboarding, systemDomainApi } from './system-domains-api';

/**
 * 次要入口：域名不在 Cloudflare 时，在站长账户新建 zone，管理员到注册商改 NS，生效后自动继续接入。
 * 输入域名 → 预检 → 逐项确认（含「改 NS 影响整个域名的 DNS」）→ 建 zone → 展示 NS 并跳转详情页等待生效。
 */
export function AddExternalDomainDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [domain, setDomain] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<SystemDomainPrecheck | null>(null);
  const [created, setCreated] = useState<SystemDomainOnboarding | null>(null);
  const selection = useAckSelection(precheck);

  useEffect(() => {
    if (open) return;
    setDomain('');
    setInputError(null);
    setPrecheck(null);
    setCreated(null);
  }, [open]);

  const check = useMutation({
    mutationFn: (value: string) => systemDomainApi.precheck({ mode: 'new_zone', domain: value }),
    onSuccess: setPrecheck,
    onError: (error) => toast({ title: error instanceof ApiError ? error.message : '检查失败，请重试', variant: 'error' }),
  });

  const create = useMutation({
    mutationFn: () => systemDomainApi.create({
      mode: 'new_zone', domain: precheck!.domain, fingerprint: precheck!.fingerprint, accept: selection.accept,
    }),
    onSuccess: (task) => {
      storeOnboarding(queryClient, task);
      setCreated(task);
    },
    onError: (error) => {
      const fresh = error instanceof ApiError ? error.details?.precheck : undefined;
      if (fresh) {
        setPrecheck(fresh);
        toast({ title: '检查结果已变化，请重新核对', variant: 'error' });
        return;
      }
      toast({ title: error instanceof ApiError ? error.message : '创建失败，请重试', variant: 'error' });
    },
  });

  const submitDomain = (event: FormEvent) => {
    event.preventDefault();
    const parsed = domainSchema.safeParse(domain.trim().toLowerCase());
    if (!parsed.success) {
      setInputError(parsed.error.issues[0]?.message ?? '域名格式非法');
      return;
    }
    setPrecheck(null);
    check.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader
          title="添加不在 Cloudflare 的域名"
          description="在站长的 Cloudflare 账户新建 zone，你到注册商把 NS 改为分配的名称服务器，生效后自动开启收发并加入系统域名。"
        />
        <DialogBody className="flex flex-col gap-4">
          {created ? (
            <div className="flex flex-col gap-3 text-[13px]">
              {created.nameServers.length > 0 ? (
                <>
                  <p className="text-ink">到 {created.domain} 的注册商，把名称服务器（NS）改为：</p>
                  <ul className="flex flex-col gap-1.5">
                    {created.nameServers.map((ns) => (
                      <li key={ns} className="flex items-center gap-2">
                        <code className="rounded-sm bg-surface-active px-2 py-1 font-mono text-xs text-ink">{ns}</code>
                        <CopyButton value={ns} label={`复制 ${ns}`} size="sm" />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-ink-secondary">{created.lastError || 'Cloudflare 暂未返回结果，系统约 10 分钟内确认，请在详情页查看。'}</p>
              )}
              <p className="text-critical">NS 生效需要时间（通常几分钟到 24 小时），生效后系统自动继续接入。</p>
            </div>
          ) : (
            <>
              <form onSubmit={submitDomain} className="flex items-start gap-2">
                <div className="flex-1">
                  <Input
                    aria-label="要添加的域名"
                    placeholder="example.com"
                    value={domain}
                    invalid={inputError !== null}
                    onChange={(event) => {
                      setDomain(event.target.value);
                      setInputError(null);
                    }}
                  />
                  {inputError && <p role="alert" className="mt-1 text-xs text-critical">{inputError}</p>}
                </div>
                <Button type="submit" variant="secondary" loading={check.isPending}>检查</Button>
              </form>
              {precheck && (
                <>
                  <p className="text-xs text-ink-tertiary">{registrarLabel(precheck.registrar)}</p>
                  {precheck.dnssec && (
                    <p className={precheck.dnssec === 'off' ? 'text-xs text-ink-tertiary' : 'flex items-start gap-1.5 text-xs text-critical'}>
                      {precheck.dnssec !== 'off' && <AlertTriangle aria-hidden className="mt-[2px] size-3.5 shrink-0" />}
                      {DNSSEC_LABEL[precheck.dnssec]}
                    </p>
                  )}
                  <p className="flex items-start gap-1.5 text-xs text-critical">
                    <AlertTriangle aria-hidden className="mt-[2px] size-3.5 shrink-0" />
                    改 NS 会影响整个域名的 DNS（网站、其他邮件服务等）。原有记录不会自动迁移，改 NS 前请在 Cloudflare 控制台补齐需要保留的记录。
                  </p>
                  <PrecheckReview precheck={precheck} checked={selection.checked} onToggle={selection.toggle} />
                </>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {created ? (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
              <Button onClick={() => { onOpenChange(false); navigate(`/admin/domains/onboarding/${created.id}`); }}>查看进度</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={create.isPending}>取消</Button>
              <Button disabled={!precheck || !selection.complete || create.isPending} loading={create.isPending} onClick={() => create.mutate()}>
                创建 zone 并获取 NS
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
