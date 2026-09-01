import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { SECRET_MASK, type UserNotifyPrefs } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { notifyPrefsApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { QueryErrorState } from '@/components/query-error-state';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { RecipientInput } from '@/features/compose/recipient-input';
import { useCurrentUser } from '@/lib/use-session';

/** 通用 webhook 回调请求体示例（与 worker webhook-notify.ts 的 WebhookMailPayload 一致） */
const WEBHOOK_SAMPLE = `{
  "event": "mail.received",
  "message": {
    "id": 123,
    "address": "you@example.com",
    "fromAddress": "sender@example.com",
    "fromName": "发件人名称",
    "subject": "邮件主题",
    "verificationCode": "123456",
    "preview": "邮件正文摘要…",
    "createdAt": "2026-07-16T01:23:45.000Z"
  }
}`;

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm font-medium text-ink">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

export function ForwardingSection() {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.notifyPrefs,
    queryFn: () => notifyPrefsApi.get(),
  });
  const [draft, setDraft] = useState<UserNotifyPrefs | null>(null);

  useEffect(() => {
    if (data) setDraft(structuredClone(data));
  }, [data]);

  const save = useMutation({
    mutationFn: (payload: UserNotifyPrefs) => notifyPrefsApi.update(payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.notifyPrefs, saved);
      setDraft(structuredClone(saved));
      toast({ title: '转发与通知已保存', variant: 'success' });
    },
    onError: (err) =>
      toast({ title: err instanceof ApiError ? err.message : '保存失败，请重试', variant: 'error' }),
  });

  const testFeishu = useMutation({
    mutationFn: () => notifyPrefsApi.testFeishu(),
    onSuccess: () => toast({ title: '测试卡片已发送', variant: 'success' }),
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '发送失败', variant: 'error' }),
  });

  if (isLoading || (data !== undefined && draft === null)) {
    return (
      <section className="rounded-lg border border-line bg-surface p-5">
        <Skeleton className="h-40 w-full rounded-md" />
      </section>
    );
  }


  if (isError || !draft || !data) {
    return <QueryErrorState error={error} onRetry={() => void refetch()} />;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(data);
  const patch = (fn: (d: UserNotifyPrefs) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-5">
      <div>
        <h2 className="text-sm font-semibold text-ink">转发与通知</h2>
        <p className="mt-0.5 text-[13px] text-ink-secondary">
          你认领地址收到的邮件会按下面的配置转发与通知。
          {isAdmin &&
            '作为管理员，这份配置还会作用于未认领地址收到的邮件（按收信当时是否已认领结算）与系统通知。'}
        </p>
      </div>

      {/* 邮箱转发 */}
      <div className="flex flex-col gap-2.5 border-t border-line pt-4">
        <ToggleRow
          label="转发到邮箱"
          checked={draft.forward.enabled}
          onChange={(v) => patch((d) => void (d.forward.enabled = v))}
        />
        <RecipientInput
          value={draft.forward.addresses}
          onChange={(addresses) => patch((d) => void (d.forward.addresses = addresses))}
          placeholder="输入目标邮箱地址后回车"
        />
        <p className="text-xs text-ink-tertiary">
          任意邮箱均可转发。已在 Cloudflare Email Routing 验证过的地址走原生转发（原样保留邮件）；
          未验证的地址由系统以 no-reply@收件域名 中转重发（标注原始发件人，直接回复即回给对方）。
        </p>
      </div>

      {/* 飞书通知 */}
      <div className="flex flex-col gap-2.5 border-t border-line pt-4">
        <ToggleRow
          label="飞书通知"
          checked={draft.feishu.enabled}
          onChange={(v) => patch((d) => void (d.feishu.enabled = v))}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">Webhook URL</span>
          <Input
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={draft.feishu.webhookUrl}
            onChange={(e) => patch((d) => void (d.feishu.webhookUrl = e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">签名密钥</span>
          <PasswordInput
            placeholder={draft.feishu.secret === SECRET_MASK ? '已配置（留空保持不变）' : '可选'}
            value={draft.feishu.secret === SECRET_MASK ? '' : draft.feishu.secret}
            onChange={(e) => patch((d) => void (d.feishu.secret = e.target.value))}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">推送内容</span>
          <SegmentedControl
            aria-label="飞书推送内容分级"
            value={draft.feishu.contentLevel}
            onValueChange={(value) =>
              patch((d) => void (d.feishu.contentLevel = value as UserNotifyPrefs['feishu']['contentLevel']))
            }
            options={[
              { value: 'code_only', label: '仅验证码' },
              { value: 'summary', label: '摘要' },
              { value: 'full', label: '全文原文' },
            ]}
          />
          <span className="text-xs text-ink-tertiary">
            摘要仅推送正文前 200 字；全文会把完整正文（含敏感信息）推送到群里，请谨慎。
          </span>
        </div>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={testFeishu.isPending}
            onClick={() => testFeishu.mutate()}
          >
            发送测试卡片
          </Button>
          <span className="ml-2 text-xs text-ink-tertiary">测试用当前已保存的配置，未保存的改动不生效。</span>
        </div>
      </div>

      {/* 通用 webhook */}
      <div className="flex flex-col gap-2.5 border-t border-line pt-4">
        <ToggleRow
          label="通用 Webhook"
          checked={draft.webhook.enabled}
          onChange={(v) => patch((d) => void (d.webhook.enabled = v))}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">Webhook URL</span>
          <Input
            placeholder="https://...（Bark / ntfy / 自建服务）"
            value={draft.webhook.url}
            onChange={(e) => patch((d) => void (d.webhook.url = e.target.value))}
          />
          <span className="text-xs text-ink-tertiary">仅支持 HTTPS，且不能指向内网地址。</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">签名密钥</span>
          <PasswordInput
            placeholder={
              draft.webhook.secret === SECRET_MASK ? '已配置（留空保持不变）' : '可选，用于 X-HPC-Signature 校验'
            }
            value={draft.webhook.secret === SECRET_MASK ? '' : draft.webhook.secret}
            onChange={(e) => patch((d) => void (d.webhook.secret = e.target.value))}
          />
        </label>

        {/* 回调请求格式说明 */}
        <details className="rounded-md border border-line bg-canvas text-[13px]">
          <summary className="cursor-pointer select-none px-3 py-2 font-medium text-ink-secondary">
            查看回调请求格式
          </summary>
          <div className="flex flex-col gap-2.5 border-t border-line px-3 py-3 text-ink-secondary">
            <p>你认领的地址每收到一封新邮件，系统就向你的 URL 发起一次请求：</p>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              <li>
                方法 <code className="rounded-sm bg-surface-active px-1 font-mono text-xs text-ink">POST</code>，请求头{' '}
                <code className="rounded-sm bg-surface-active px-1 font-mono text-xs text-ink">
                  Content-Type: application/json
                </code>
              </li>
              <li>超时 10 秒；失败静默、不重试（通知尽力而为，不阻断收件）</li>
            </ul>
            <p className="font-medium text-ink">请求体（JSON）：</p>
            <pre className="overflow-x-auto rounded-md bg-surface-active p-3 font-mono text-xs leading-relaxed text-ink">
              {WEBHOOK_SAMPLE}
            </pre>
            <p>
              字段说明：<code className="font-mono text-xs">address</code> 你的收件地址、
              <code className="font-mono text-xs">verificationCode</code> 自动提取的验证码（无则空串）、
              <code className="font-mono text-xs">preview</code> 正文摘要、
              <code className="font-mono text-xs">createdAt</code> ISO-8601 UTC 时间。
            </p>
            <p className="font-medium text-ink">验签（填了签名密钥时）：</p>
            <p>
              请求头会带{' '}
              <code className="rounded-sm bg-surface-active px-1 font-mono text-xs text-ink">X-HPC-Signature</code>，其值为{' '}
              <code className="font-mono text-xs">Base64( HMAC-SHA256( 密钥, 原始请求体字节 ) )</code>
              。用同一密钥对收到的 raw body 重算并比对，一致才可信——可防伪造与篡改。
            </p>
          </div>
        </details>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
        {dirty && <span className="text-xs text-ink-tertiary">有未保存的改动</span>}
        <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>
          保存
        </Button>
      </div>
    </section>
  );
}
