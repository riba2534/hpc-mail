import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import type { AiModelTestRequest, AiModelTestResult, Settings } from '@hpc-mail/shared';
import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { UnsavedChangesGuard } from '@/components/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';

/** 保留前缀文本 → 数组：逗号（含全角）、顿号、空白、换行均可分隔，转小写并去重 */
export function parseReservedLocalParts(text: string): string[] {
  const items = text
    .split(/[\s,，、]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)];
}

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

/** 与 @hpc-mail/shared 的 SECRET_MASK 一致（测试校验）；本地定义，设置页 chunk 不必引入 shared 运行时 */
export const SECRET_MASK = '******';

type AiModelSetting = Settings['ai_model'];

/** 测试连接只有本页用到，不放进入口 chunk 里的 api/resources.ts */
const testAiModel = (body: AiModelTestRequest) =>
  api.post<AiModelTestResult, AiModelTestRequest>('/admin/settings/ai-model-test', body, { timeoutMs: 60_000 });

/** 三项都填了（API Key 为掩码也算已配置）才视为可用，与服务端判定一致 */
const aiModelReady = (model: AiModelSetting | undefined) => Boolean(model?.baseUrl && model.apiKey && model.model);

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

/** 全站 AI 模型（OpenAI 兼容接口）。API Key 回显为掩码：提交掩码表示保持原值，提交空串表示删除 */
function AiModelSection({
  value,
  saved,
  onChange,
}: {
  value: AiModelSetting;
  saved: AiModelSetting | undefined;
  onChange: (updater: (model: AiModelSetting) => void) => void;
}) {
  const savedKey = saved?.apiKey === SECRET_MASK;
  const test = useMutation({ mutationFn: testAiModel });
  // 表单改动后，旧的测试结果不再代表当前配置
  const tested = test.variables?.baseUrl === value.baseUrl && test.variables.apiKey === value.apiKey && test.variables.model === value.model;
  const insecureUrl = value.baseUrl !== '' && !value.baseUrl.startsWith('https://');

  return (
    <Section
      title="AI 模型"
      description="翻译与验证码 AI 兜底识别共用此模型（OpenAI 兼容接口，如 DeepSeek：https://api.deepseek.com / deepseek-flash）。"
    >
      <p className="rounded-md border border-line bg-canvas p-3 text-sm text-ink-secondary">
        配置后，含验证码关键词但正则未识别出验证码的来信，其主题和正文前 6000 字会发送到该服务；用户点击翻译时，会发送所翻译邮件的片段。
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">接口地址</span>
        <span className="text-xs text-ink-tertiary">接口根地址，不含 /chat/completions，仅支持 https。</span>
        <Input
          value={value.baseUrl}
          placeholder="https://api.deepseek.com"
          inputMode="url"
          invalid={insecureUrl}
          onChange={(event) => onChange((m) => void (m.baseUrl = event.target.value.trim()))}
        />
        {insecureUrl && <span className="text-xs text-critical">接口地址必须以 https:// 开头</span>}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">模型</span>
        <Input
          value={value.model}
          placeholder="deepseek-flash"
          onChange={(event) => onChange((m) => void (m.model = event.target.value.trim()))}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">API Key</span>
          <PasswordInput
            autoComplete="off"
            placeholder={value.apiKey === SECRET_MASK ? '已配置（输入可替换，清除请用按钮）' : savedKey ? '保存后将删除已配置的 Key' : '未配置'}
            value={value.apiKey === SECRET_MASK ? '' : value.apiKey}
            // 输入后再删空，回到「保持原值」；删除已保存的 Key 用下方按钮
            onChange={(event) => {
              const next = event.target.value.trim();
              onChange((m) => void (m.apiKey = next === '' && savedKey ? SECRET_MASK : next));
            }}
          />
        </label>
        {value.apiKey && (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange((m) => void (m.apiKey = ''))}>
              清除 API Key
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={test.isPending}
            disabled={!aiModelReady(value) || insecureUrl}
            onClick={() => test.mutate({ baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model })}
          >
            测试连接
          </Button>
          <span className="text-xs text-ink-tertiary">使用当前表单中的配置，无需先保存。</span>
        </div>
        {tested && test.isSuccess && (
          <div role="status" className="rounded-md border border-positive/40 bg-positive-soft p-3 text-sm">
            <p className="font-medium text-positive">连接成功 · 耗时 {test.data.latencyMs} ms</p>
            {test.data.sample && <p className="mt-1 break-words text-ink-secondary">示例译文：{test.data.sample}</p>}
          </div>
        )}
        {tested && test.isError && (
          <p role="alert" className="rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-critical">
            {test.error instanceof ApiError ? test.error.message : '测试失败，请检查配置'}
          </p>
        )}
      </div>
    </Section>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: () => adminApi.getSettings(),
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  // 保留前缀输入框的原始文本：输入过程中保留用户敲的分隔符，失焦或重置草稿时再规范化显示
  const [reservedText, setReservedText] = useState<string | null>(null);

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
    mutationFn: (payload: Settings) => {
      // Domain edits have their own revision check on the domain page; never resubmit a stale copy here.
      const { domains: _domains, ...settings } = payload;
      return adminApi.updateSettings(settings);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.admin.settings, saved);
      setDraft(structuredClone(saved));
      setReservedText(null);
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
    <div className="mx-auto max-w-3xl pb-20">
      <PageHeader title="系统设置" description="站点级配置，保存后立即生效。" />
      <UnsavedChangesGuard when={dirty} description="系统设置有未保存的更改，离开后这些更改会丢失。" />

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

        {/* 旧版本服务端没有 ai_model / translation 设置时不显示对应分区 */}
        {draft.ai_model && (
          <AiModelSection
            value={draft.ai_model}
            saved={data.ai_model}
            onChange={(updater) => patch((s) => updater(s.ai_model))}
          />
        )}

        <Section title="验证码提取" description="从收件正文中自动识别一次性验证码。">
          <ToggleRow
            label="启用验证码提取"
            checked={draft.code_extract.enabled}
            onChange={(value) => patch((s) => void (s.code_extract.enabled = value))}
          />
          <ToggleRow
            label="AI 兜底提取"
            description="使用上方 AI 模型；未配置模型时只用正则识别。"
            checked={draft.code_extract.aiEnabled}
            onChange={(value) => patch((s) => void (s.code_extract.aiEnabled = value))}
          />
        </Section>

        {draft.translation && (
          <Section title="AI 翻译" description="在邮件详情把主题与正文翻译成简体中文。">
            <ToggleRow
              label="启用 AI 翻译"
              description={aiModelReady(draft.ai_model) ? undefined : '需先配置 AI 模型'}
              checked={draft.translation.enabled}
              onChange={(value) => patch((s) => void (s.translation.enabled = value))}
            />
            <NumberRow
              label="每用户每日翻译上限"
              description="按原文字符数计，命中缓存不计入。0 表示不限。"
              value={draft.translation.dailyCharsPerUser}
              onChange={(v) => patch((s) => void (s.translation.dailyCharsPerUser = v))}
              max={10_000_000}
              suffix="字符/天"
            />
          </Section>
        )}

        <Section
          title="邮件保留策略"
          description="catch-all 会收下发往任意地址的邮件，需定期清理防止无限膨胀撑爆存储。0 表示不清理。"
        >
          {(draft.retention.unclaimedDays === 0 || draft.retention.allMessagesDays === 0) && <p className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
            当前至少一项保留策略为 0，邮件可能持续累积。请定期检查 Cloudflare D1 和 R2 的用量；设置非零天数后会永久清理到期邮件，请按需要决定。
          </p>}
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
              普通用户禁止认领这些前缀（防冒充官方身份）。可用逗号、空格或换行分隔，自动转为小写并去重。
            </span>
            <Textarea
              rows={3}
              value={reservedText ?? draft.mailbox_policy.reservedLocalParts.join(', ')}
              placeholder="admin, postmaster, abuse, noreply"
              onChange={(event) => {
                const text = event.target.value;
                setReservedText(text);
                patch((s) => void (s.mailbox_policy.reservedLocalParts = parseReservedLocalParts(text)));
              }}
              onBlur={() => setReservedText(null)}
            />
            <span className="text-xs text-ink-tertiary">共 {draft.mailbox_policy.reservedLocalParts.length} 个</span>
          </label>
        </Section>
      </div>

      {dirty && (
        // 移动端停在底部导航（4rem + 安全区）之上；桌面贴底并让开左侧栏
        <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-line bg-surface px-4 py-3 shadow-md md:bottom-0 md:left-16 md:px-6 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:left-[220px]">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <span className="text-sm text-ink-secondary">有未保存的更改</span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft(structuredClone(data));
                  setReservedText(null);
                }}
                disabled={save.isPending}
              >
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
