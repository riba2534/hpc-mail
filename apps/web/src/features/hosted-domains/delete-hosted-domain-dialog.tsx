import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HostedDomain } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { hostedDomainApi } from './hosted-domains-api';
import { forgetHostedDomain } from './use-hosted-domains';

export function DeleteHostedDomainDialog({
  domain,
  open,
  onOpenChange,
}: {
  domain: HostedDomain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    if (open) setConfirmText('');
  }, [open]);

  const confirmed = confirmText.trim().toLowerCase() === domain.domain;

  const remove = useMutation({
    mutationFn: () => hostedDomainApi.remove(domain.id),
    onSuccess: () => {
      toast({ title: `已删除 ${domain.domain} 的托管`, description: '后台会继续清理地址、邮件与 Cloudflare 配置。', variant: 'success' });
      onOpenChange(false);
      navigate(domain.role === 'admin' ? '/admin/hosted-domains' : '/domains', { replace: true });
      forgetHostedDomain(queryClient, domain.id);
      // 该域名下的地址全部释放、邮件永久删除
      invalidateMailboxOwnership(queryClient);
    },
    onError: (error) => toast({ title: error instanceof ApiError ? error.message : '删除失败，请重试', variant: 'error' }),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader title="删除托管" description={domain.domain} />
        <DialogBody className="flex flex-col gap-4 text-sm">
          <div className="rounded-md border border-caution/40 bg-caution-soft/40 p-3">
            <p className="flex items-center gap-1.5 font-medium text-caution">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              先到注册商把名称服务器改回原值
            </p>
            <p className="mt-1 text-ink-secondary">
              否则删除后该域名无法解析，网站、邮件等都将不可用；在改回之前，其他用户也无法在本站添加这个域名。
            </p>
            {domain.originalNameServers.length > 0 ? (
              <ul aria-label="原名称服务器" className="mt-2 flex flex-col gap-1.5">
                {domain.originalNameServers.map((ns) => (
                  <li key={ns} className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-sm bg-surface-active px-2 py-1 font-mono text-xs text-ink">
                      {ns}
                    </code>
                    <CopyButton value={ns} ariaLabel={`复制 ${ns}`} size="sm" className="shrink-0" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-ink-secondary">没有记录到原名称服务器，请改回原 DNS 服务商提供的值。</p>
            )}
          </div>
          <div className="rounded-md border border-critical/40 bg-critical-soft p-3">
            <p className="font-medium text-critical">删除不可恢复</p>
            <p className="mt-1 text-ink-secondary">
              将释放该域名下全部 <b className="text-ink">{domain.mailboxCount}</b> 个地址（含成员认领的地址），并
              <b className="text-ink">永久删除</b>这些地址的全部邮件；成员也会失去该域名。
            </p>
          </div>
          <FormField label={`输入 ${domain.domain} 确认删除`}>
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                placeholder={domain.domain}
                value={confirmText}
                disabled={remove.isPending}
                onChange={(event) => setConfirmText(event.target.value)}
              />
            )}
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={remove.isPending} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="danger" loading={remove.isPending} disabled={!confirmed} onClick={() => remove.mutate()}>
            删除托管
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
