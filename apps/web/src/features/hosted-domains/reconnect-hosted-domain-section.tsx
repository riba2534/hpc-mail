import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlugZap } from 'lucide-react';
import { useState } from 'react';
import type { HostedDomain } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { hostedDomainApi } from './hosted-domains-api';
import { storeHostedDomain } from './use-hosted-domains';

/** 名称服务器已改走的域名：所有者与管理员可以重新接入，地址与历史邮件保留 */
export function ReconnectHostedDomainSection({ domain }: { domain: HostedDomain }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const reconnect = useMutation({
    mutationFn: () => hostedDomainApi.reconnect(domain.id),
    onSuccess: (updated) => {
      storeHostedDomain(queryClient, updated);
      setOpen(false);
      if (updated.status === 'pending') {
        toast({ title: '已重新接入', description: '请到注册商把名称服务器改为新分配的两条', variant: 'success' });
      } else if (updated.status === 'moved') {
        toast({ title: '已请 Cloudflare 复查名称服务器', description: '名称服务器仍未指向本站，改回后会自动恢复' });
      } else {
        toast({ title: '域名已恢复', variant: 'success' });
      }
    },
    onError: (error) => toast({ title: error instanceof ApiError ? error.message : '重新接入失败，请稍后重试', variant: 'error' }),
  });

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-critical/40 bg-surface p-5">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-ink">重新接入</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Cloudflare 通常在名称服务器改走约 7 天后删除该域名的 zone。删除前把名称服务器改回即可恢复；已被删除时点「重新接入」，
          系统会重新分配名称服务器，已认领的地址和历史邮件都保留。
        </p>
      </div>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <PlugZap className="size-4" />
        重新接入
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !reconnect.isPending && setOpen(next)}
        title={`重新接入 ${domain.domain}？`}
        description={
          <div className="flex flex-col gap-2">
            <p>
              如果 Cloudflare 中的 zone 已被删除，系统会重新创建并<b className="text-ink">分配新的名称服务器</b>
              ，你需要到注册商把名称服务器改成新分配的两条；zone 仍在时只会请 Cloudflare 立即复查名称服务器。
            </p>
            <p>已认领的地址、历史邮件和成员都会保留。</p>
          </div>
        }
        confirmLabel="重新接入"
        loading={reconnect.isPending}
        onConfirm={() => reconnect.mutate()}
      />
    </section>
  );
}
