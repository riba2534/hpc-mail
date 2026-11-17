import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { SECRET_MASK, type NotifyPrefsView, type UserNotifyPrefs, updateNotifyPrefsRequestSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { notifyPrefsApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { QueryErrorState } from '@/components/query-error-state';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
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
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm font-medium text-ink">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/** 通道区块：开关打开才展开配置项；关闭时保留已填内容，只是不显示 */
function ChannelBlock({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-4">
      <ToggleRow label={label} checked={enabled} onChange={onToggle} />
      {enabled && children}
    </div>
  );
}

type TestChannel = 'feishu' | 'pushdeer';

/**
 * 编辑用的草稿：转发目标显示已确认与等待确认的全部地址。保存时整张列表发给服务端，
 * 已确认的保留、仍在等待的不重发、新加的发确认信；从列表删掉的等待项撤销确认。
 */
export function toDraft(view: NotifyPrefsView): UserNotifyPrefs {
  const pending = view.forwardPending.map((item) => item.address).filter((address) => !view.forward.addresses.includes(address));
  return {
    feishu: view.feishu,
    webhook: view.webhook,
    pushdeer: view.pushdeer,
    forward: { enabled: view.forward.enabled, addresses: [...view.forward.addresses, ...pending] },
  };
}

const TEST_HINT = '有未保存的改动时会先自动保存，再用保存后的配置发送测试。';

export function ForwardingSection({ id }: { id?: string }) {
  const user = useCurrentUser();
  const isAdmin = user.role === 'admin';
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.notifyPrefs,
    queryFn: () => notifyPrefsApi.get(),
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserNotifyPrefs | null>(null);
  const [testing, setTesting] = useState<TestChannel | null>(null);
  // 新增转发目标或打开转发时服务端要求当前密码：先不带密码保存，收到 reauth_required 再弹窗补上
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(toDraft(data));
  }, [data]);

  const save = useMutation({
    mutationFn: ({ payload, password }: { payload: UserNotifyPrefs; password?: string }) =>
      notifyPrefsApi.update(password ? { ...payload, password } : payload),
    onSuccess: (saved, { payload }) => {
      const before = data ? toDraft(data).forward.addresses : [];
      queryClient.setQueryData(queryKeys.notifyPrefs, saved);
      setDraft(toDraft(saved));
      setValidationError(null);
      setReauthOpen(false);
      setReauthPassword('');
      void queryClient.invalidateQueries({queryKey:queryKeys.notificationHealth});
      const invited = saved.forwardPending.map((item) => item.address)
        .filter((address) => payload.forward.addresses.includes(address) && !before.includes(address));
      toast(invited.length
        ? { title: '已保存，确认邮件已发出', description: `${invited.join('、')} 的主人确认后才开始转发`, variant: 'success' }
        : { title: '转发与通知已保存', variant: 'success' });
    },
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'reauth_required' || err.code === 'reauth_failed')) {
        setReauthError(err.code === 'reauth_failed' ? err.message : null);
        setReauthOpen(true);
        return;
      }
      toast({ title: err instanceof ApiError ? err.message : '保存失败，请重试', variant: 'error' });
    },
  });

  const sendTest = useMutation({
    mutationFn: (channel: TestChannel) =>
      channel === 'feishu' ? notifyPrefsApi.testFeishu() : notifyPrefsApi.testPushdeer(),
    onSuccess: (_data, channel) => {
      void queryClient.invalidateQueries({queryKey:queryKeys.notificationHealth});
      toast({ title: channel === 'feishu' ? '测试卡片已发送' : '测试消息已发送至 PushDeer', variant: 'success' });
    },
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '发送失败', variant: 'error' }),
  });

  if (isLoading || (data !== undefined && draft === null)) {
    return (
      <section id={id} className="scroll-mt-20 rounded-lg border border-line bg-surface p-5">
        <Skeleton className="h-40 w-full rounded-md" />
      </section>
    );
  }

  if (isError || !draft || !data) {
    return (
      <div id={id} className="scroll-mt-20">
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(data));
  const pendingByAddress = new Map(data.forwardPending.map((item) => [item.address, item.expiresAt]));
  const patch = (fn: (d: UserNotifyPrefs) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });
  };

  /** 校验并保存当前草稿；校验或保存失败返回 false（需要密码时弹窗，确认后再保存一次） */
  const saveDraft = async (password?: string): Promise<boolean> => {
    const parsed = updateNotifyPrefsRequestSchema.safeParse(draft);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? '请检查配置');
      return false;
    }
    setValidationError(null);
    try {
      await save.mutateAsync({ payload: draft, password });
      return true;
    } catch {
      return false;
    }
  };

  // 测试只会用服务端已保存的配置：有未保存改动时先自动保存，避免「测的不是眼前这份」
  const runTest = async (channel: TestChannel) => {
    setTesting(channel);
    try {
      if (dirty && !(await saveDraft())) return;
      await sendTest.mutateAsync(channel).catch(() => {});
    } finally {
      setTesting(null);
    }
  };

  const testLabel = (base: string) => (dirty ? `保存并${base}` : base);

  return (
    <section id={id} tabIndex={-1} className="flex scroll-mt-20 flex-col gap-5 rounded-lg border border-line bg-surface p-5 focus:outline-none">
      <UnsavedChangesGuard when={dirty} description="转发与通知有未保存的改动，离开后这些改动会丢失。" />
      <div>
        <h2 className="text-sm font-semibold text-ink">转发与通知</h2>
        <p className="mt-0.5 text-[13px] text-ink-secondary">
          你认领地址收到的邮件会按下面的配置转发与通知。
          {isAdmin &&
            '作为管理员，这份配置还会作用于未认领地址收到的邮件（按收信当时是否已认领结算）与系统通知。'}
        </p>
      </div>

      {/* 邮箱转发 */}
      <ChannelBlock
        label="转发到邮箱"
        enabled={draft.forward.enabled}
        onToggle={(v) => patch((d) => void (d.forward.enabled = v))}
      >
        <RecipientInput
          aria-label="转发目标邮箱"
          value={draft.forward.addresses}
          onChange={(addresses) => patch((d) => void (d.forward.addresses = addresses))}
          placeholder="输入目标邮箱地址后回车"
        />
        {draft.forward.addresses.some((address) => pendingByAddress.has(address)) && (
          <ul aria-label="等待确认的转发目标" className="flex flex-col gap-1 text-xs text-caution">
            {draft.forward.addresses.filter((address) => pendingByAddress.has(address)).map((address) => (
              <li key={address}>
                {address}：等待对方确认，确认链接 {new Date(pendingByAddress.get(address)!).toLocaleString('zh-CN', { hour12: false })} 前有效
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-tertiary">
          新加的地址会先收到一封确认邮件，对方点确认后才开始转发；新增地址或打开转发需要输入当前密码。
          已在 Cloudflare Email Routing 验证过的地址走原生转发（原样保留邮件）；
          其余地址由系统以 no-reply@收件域名 中转重发（标注原始发件人，直接回复即回给对方）。
        </p>
      </ChannelBlock>

      {/* 飞书通知 */}
      <ChannelBlock
        label="飞书通知"
        enabled={draft.feishu.enabled}
        onToggle={(v) => patch((d) => void (d.feishu.enabled = v))}
      >
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
            placeholder={draft.feishu.secret === SECRET_MASK ? '已配置（输入可替换，清除请用按钮）' : '可选'}
            value={draft.feishu.secret === SECRET_MASK ? '' : draft.feishu.secret}
            onChange={(e) => patch((d) => void (d.feishu.secret = e.target.value))}
          />
        </label>
        {draft.feishu.secret && <div><Button type="button" variant="ghost" size="sm" onClick={() => patch((d) => void (d.feishu.secret = ''))}>清除飞书签名密钥</Button></div>}
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={testing === 'feishu'}
            disabled={testing !== null}
            onClick={() => void runTest('feishu')}
          >
            {testLabel('发送测试卡片')}
          </Button>
          <span className="text-xs text-ink-tertiary">{TEST_HINT}</span>
        </div>
      </ChannelBlock>

      {/* PushDeer 通知 */}
      <ChannelBlock
        label="PushDeer 通知"
        enabled={draft.pushdeer.enabled}
        onToggle={(v) => patch((d) => void (d.pushdeer.enabled = v))}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">PushKey</span>
          <PasswordInput
            placeholder={
              draft.pushdeer.pushkey === SECRET_MASK ? '已配置（输入可替换，清除请用按钮）' : '例如 PDU...'
            }
            value={draft.pushdeer.pushkey === SECRET_MASK ? '' : draft.pushdeer.pushkey}
            onChange={(e) => patch((d) => void (d.pushdeer.pushkey = e.target.value))}
          />
          <span className="text-xs text-ink-tertiary">
            PushDeer App 内生成的 Key（支持 iOS、Android、Mac 客户端）。
          </span>
        </label>
        {draft.pushdeer.pushkey && <div><Button type="button" variant="ghost" size="sm" onClick={() => patch((d) => void (d.pushdeer.pushkey = ''))}>清除PushDeer Key</Button></div>}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">自定义服务器端点（可选）</span>
          <Input
            placeholder="留空默认使用官方服务 (https://api2.pushdeer.com)"
            value={draft.pushdeer.endpoint}
            onChange={(e) => patch((d) => void (d.pushdeer.endpoint = e.target.value))}
          />
          <span className="text-xs text-ink-tertiary">
            若使用自建 PushDeer 服务器，请输入完整服务地址（如 https://pushdeer.example.com）。
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={testing === 'pushdeer'}
            disabled={testing !== null}
            onClick={() => void runTest('pushdeer')}
          >
            {testLabel('发送测试消息')}
          </Button>
          <span className="text-xs text-ink-tertiary">{TEST_HINT}</span>
        </div>
      </ChannelBlock>

      {/* 通用 webhook */}
      <ChannelBlock
        label="通用 Webhook"
        enabled={draft.webhook.enabled}
        onToggle={(v) => patch((d) => void (d.webhook.enabled = v))}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">Webhook URL</span>
          <Input
            placeholder="https://...（接收 HPC 事件的服务）"
            value={draft.webhook.url}
            onChange={(e) => patch((d) => void (d.webhook.url = e.target.value))}
          />
          <span className="text-xs text-ink-tertiary">仅支持 HTTPS 公网地址；Bark、ntfy 等服务需要适配下方 HPC JSON 事件格式。</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-secondary">签名密钥</span>
          <PasswordInput
            placeholder={
              draft.webhook.secret === SECRET_MASK ? '已配置（输入可替换，清除请用按钮）' : '可选，用于 X-HPC-Signature 校验'
            }
            value={draft.webhook.secret === SECRET_MASK ? '' : draft.webhook.secret}
            onChange={(e) => patch((d) => void (d.webhook.secret = e.target.value))}
          />
        </label>
        {draft.webhook.secret && <div><Button type="button" variant="ghost" size="sm" onClick={() => patch((d) => void (d.webhook.secret = ''))}>清除Webhook 签名密钥</Button></div>}

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
              <li>超时 10 秒；自动通知失败会记录结果，Webhook 不自动重试，可在下方确认后手动重试（不阻断收件）</li>
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
      </ChannelBlock>

      {validationError && <p role="alert" className="text-sm text-critical">{validationError}</p>}
      <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
        {dirty && <span className="text-xs text-ink-tertiary">有未保存的改动</span>}
        <Button disabled={!dirty || testing !== null} loading={save.isPending && testing === null} onClick={() => void saveDraft()}>
          保存
        </Button>
      </div>

      <Dialog open={reauthOpen} onOpenChange={(next) => !next && setReauthOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader title="确认当前密码" description="新增转发目标或打开转发会把来信发往外部邮箱，请输入当前密码确认。" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (reauthPassword) void saveDraft(reauthPassword);
            }}
          >
            <DialogBody>
              <PasswordInput
                autoFocus
                aria-label="当前密码"
                placeholder="当前密码"
                autoComplete="current-password"
                value={reauthPassword}
                invalid={reauthError !== null}
                onChange={(event) => {
                  setReauthPassword(event.target.value);
                  setReauthError(null);
                }}
              />
              {reauthError && <p role="alert" className="mt-2 text-sm text-critical">{reauthError}</p>}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setReauthOpen(false)}>
                取消
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!reauthPassword}>
                确认并保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
