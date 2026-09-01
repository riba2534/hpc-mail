import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { type Settings } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-secondary">{description}</p>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-ink">{label}</span>
        {description && <span className="text-xs text-ink-tertiary">{description}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

function NumberRow({
  label,
  description,
  value,
  onChange,
  min = 0,
  max,
  suffix,
}: {
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-sm font-medium text-ink">{label}</span>
        {description && <span className="text-xs text-ink-tertiary">{description}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Input
          type="number"
          className="w-28 text-right"
          value={String(value)}
          min={min}
          max={max}
          onChange={(event) => {
            const n = Math.floor(Number(event.target.value));
            if (Number.isFinite(n)) onChange(Math.max(min, max === undefined ? n : Math.min(max, n)));
          }}
        />
        {suffix && <span className="text-xs text-ink-tertiary">{suffix}</span>}
      </span>
    </label>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: () => adminApi.getSettings(),
  });
  const [draft, setDraft] = useState<Settings | null>(null);

  useEffect(() => {
    if (data && draft === null) setDraft(structuredClone(data));
  }, [data, draft]);

  const patch = (updater: (settings: Settings) => void) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      updater(next);
      return next;
    });

  const save = useMutation({
    mutationFn: (payload: Settings) => adminApi.updateSettings(payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.admin.settings, saved);
      setDraft(structuredClone(saved));
      void queryClient.invalidateQueries({ queryKey: queryKeys.config });
      toast({ title: '设置已保存', variant: 'success' });
    },
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '保存失败，请重试', variant: 'error' }),
  });

  if (isLoading || (data !== undefined && draft === null)) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data || !draft) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="系统设置" description="站点级配置，保存后立即生效。" />
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(data);

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <PageHeader title="系统设置" description="站点级配置，保存后立即生效。" />

      <div className="flex flex-col gap-4">
        <Section title="站点">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">站点标题</span>
            <Input
              value={draft.site.title}
              maxLength={64}
              onChange={(event) => patch((s) => void (s.site.title = event.target.value))}
            />
          </label>
          <ToggleRow
            label="开放 API"
            description="关闭后所有 /v1 请求将被拒绝。"
            checked={draft.api.enabled}
            onChange={(value) => patch((s) => void (s.api.enabled = value))}
          />
        </Section>

        <Section title="安全" description="账户安全策略。">
          <ToggleRow
            label="强制两步验证"
            description="开启后，未启用 2FA 的用户登录后会被引导到个人设置完成绑定。"
            checked={draft.security.require2fa}
            onChange={(value) => patch((s) => void (s.security.require2fa = value))}
          />
        </Section>

        <Section title="注册模式" description="控制新用户如何注册平台账户。">
          <SegmentedControl
            aria-label="注册模式"
            value={draft.register_mode}
            onValueChange={(value) => patch((s) => void (s.register_mode = value))}
            options={[
              { value: 'closed', label: '关闭' },
              { value: 'invite', label: '邀请码' },
              { value: 'open', label: '开放' },
            ]}
          />
        </Section>

        <Section title="验证码提取" description="从收件正文中自动识别一次性验证码。">
          <ToggleRow
            label="启用验证码提取"
            checked={draft.code_extract.enabled}
            onChange={(value) => patch((s) => void (s.code_extract.enabled = value))}
          />
          <ToggleRow
            label="AI 兜底提取"
            description="正则未命中时用 Workers AI 异步补充。"
            checked={draft.code_extract.aiEnabled}
            onChange={(value) => patch((s) => void (s.code_extract.aiEnabled = value))}
          />
        </Section>

        <Section
          title="邮件保留策略"
          description="catch-all 会收下发往任意地址的邮件，需定期清理防止无限膨胀撑爆存储。0 表示不清理。"
        >
          <NumberRow
            label="未认领地址邮件保留"
            description="发往无人认领地址的邮件（垃圾邮件主要来源）超期自动删除。建议 90 天。"
            value={draft.retention.unclaimedDays}
            onChange={(v) => patch((s) => void (s.retention.unclaimedDays = v))}
            max={3650}
            suffix="天"
          />
          <NumberRow
            label="全局邮件保留上限"
            description="所有邮件（含已认领）的总保留上限兜底。0 表示不限，谨慎开启。"
            value={draft.retention.allMessagesDays}
            onChange={(v) => patch((s) => void (s.retention.allMessagesDays = v))}
            max={3650}
            suffix="天"
          />
        </Section>

        <Section
          title="外发配额"
          description="限制普通用户每日外发量，防被盗账号脚本化群发。管理员不受限。0 表示不限。"
        >
          <NumberRow
            label="每日外发邮件上限"
            value={draft.quota.dailyOutbound}
            onChange={(v) => patch((s) => void (s.quota.dailyOutbound = v))}
            max={100000}
            suffix="封/天"
          />
          <NumberRow
            label="每日外发收件人上限"
            description="站内与站外唯一收件人总数，防止站内群发放大存储。"
            value={draft.quota.dailyRecipients}
            onChange={(v) => patch((s) => void (s.quota.dailyRecipients = v))}
            max={1000000}
            suffix="人/天"
          />
        </Section>

        <Section
          title="邮箱认领策略"
          description="约束普通用户认领行为（管理员不受限）。"
        >
          <NumberRow
            label="每用户认领上限"
            description="单个普通用户最多可认领的地址数。0 表示不限。"
            value={draft.mailbox_policy.perUserLimit}
            onChange={(v) => patch((s) => void (s.mailbox_policy.perUserLimit = v))}
            max={10000}
            suffix="个"
          />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">保留前缀</span>
            <span className="text-xs text-ink-tertiary">
              普通用户禁止认领这些前缀（防冒充官方身份），逗号分隔。
            </span>
            <Input
              value={draft.mailbox_policy.reservedLocalParts.join(', ')}
              placeholder="admin, postmaster, abuse, noreply"
              onChange={(event) =>
                patch(
                  (s) =>
                    void (s.mailbox_policy.reservedLocalParts = event.target.value
                      .split(/[,\s]+/)
                      .map((x) => x.trim().toLowerCase())
                      .filter(Boolean)),
                )
              }
            />
          </label>
        </Section>
      </div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:pl-[220px]">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm text-ink-secondary">有未保存的更改</span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setDraft(structuredClone(data))} disabled={save.isPending}>
                放弃
              </Button>
              <Button loading={save.isPending} onClick={() => save.mutate(draft)}>
                保存更改
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
