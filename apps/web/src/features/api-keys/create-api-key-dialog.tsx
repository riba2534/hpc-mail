import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  API_SCOPES,
  type ApiScope,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  DEFAULT_API_RATE_LIMIT,
  MAX_API_RATE_LIMIT,
  createApiKeyRequestSchema,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { apiKeyApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

const SCOPE_LABELS: Record<ApiScope, string> = {
  'mail.read': '读取邮件',
  'mail.write': '标记已读/删除',
  'mail.send': '发送邮件',
  'mailbox.read': '读取邮箱',
  'mailbox.write': '管理邮箱',
};

type ScopePreset = 'read' | 'send' | 'full' | 'custom';

export const SCOPE_PRESETS: ReadonlyArray<{
  value: Exclude<ScopePreset, 'custom'>;
  label: string;
  scopes: readonly ApiScope[];
}> = [
  { value: 'read', label: '只读收信', scopes: ['mail.read', 'mailbox.read'] },
  { value: 'send', label: '收发信', scopes: ['mail.read', 'mail.write', 'mail.send', 'mailbox.read'] },
  { value: 'full', label: '完全访问', scopes: API_SCOPES },
];

const DEFAULT_SCOPES = SCOPE_PRESETS[0]!.scopes;

/** 勾选结果恰好等于某个预设时返回它，否则为自定义 */
export function matchScopePreset(scopes: readonly ApiScope[]): ScopePreset {
  const set = new Set(scopes);
  const found = SCOPE_PRESETS.find(
    (preset) => preset.scopes.length === set.size && preset.scopes.every((scope) => set.has(scope)),
  );
  return found?.value ?? 'custom';
}

type ExpiryPreset = '7' | '30' | '90' | 'never' | 'custom';

const EXPIRY_OPTIONS: ReadonlyArray<{ value: ExpiryPreset; label: string }> = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: 'never', label: '永不过期' },
  { value: 'custom', label: '自定义' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 预设天数换算为绝对过期时间；永不过期为 undefined */
export function expiryFromPreset(preset: ExpiryPreset, custom: string, now = Date.now()): string | undefined {
  if (preset === 'never') return undefined;
  if (preset === 'custom') return custom ? new Date(custom).toISOString() : undefined;
  return new Date(now + Number(preset) * DAY_MS).toISOString();
}

/** 按密钥权限挑一个能直接跑通的只读示例 */
export function buildCurlExample(key: string, scopes: readonly ApiScope[], origin: string): string {
  const path = scopes.includes('mail.read')
    ? '/v1/messages?limit=5'
    : scopes.includes('mailbox.read')
      ? '/v1/mailboxes'
      : '/v1/status';
  return `curl -H "Authorization: Bearer ${key}" "${origin}${path}"`;
}

function exampleCaption(scopes: readonly ApiScope[]): string {
  if (scopes.includes('mail.read')) return '读取最近 5 封邮件：';
  if (scopes.includes('mailbox.read')) return '列出你认领的邮箱：';
  return '检查密钥状态：';
}

function CreatedKeyGuide({ created }: { created: CreatedApiKey }) {
  const curl = buildCurlExample(created.key, created.scopes, globalThis.location.origin);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-sm font-medium text-ink">快速试用</p>
      <p className="text-[13px] text-ink-secondary">{exampleCaption(created.scopes)}</p>
      <pre
        aria-label="curl 示例"
        className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs leading-relaxed text-ink"
      >
        {curl}
      </pre>
      <div>
        <CopyButton value={curl} label="复制命令" size="sm" />
      </div>
      {created.scopes.includes('mail.send') && (
        <p className="text-[13px] text-ink-secondary">
          发信：<code className="font-mono text-xs text-ink">POST /v1/messages</code>，请求体字段见接入说明。
        </p>
      )}
      <a
        href="/skill.md"
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-hover hover:underline"
      >
        给 AI Agent 的接入说明
        <ExternalLink className="size-3.5" />
      </a>
    </div>
  );
}

export function CreateApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([...DEFAULT_SCOPES]);
  // 点「自定义」后即便勾选恰好等于某预设也保持自定义高亮，直到再次勾选
  const [customScopes, setCustomScopes] = useState(false);
  const [rateLimit, setRateLimit] = useState(DEFAULT_API_RATE_LIMIT);
  const [allowedIpsText, setAllowedIpsText] = useState('');
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('never');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const create = useMutation({
    mutationFn: (payload: CreateApiKeyRequest) => apiKeyApi.create(payload),
    onSuccess: (data) => {
      setCreated(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.root });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '创建失败，请重试'),
  });

  const resetAndClose = () => {
    setName('');
    setScopes([...DEFAULT_SCOPES]);
    setCustomScopes(false);
    setRateLimit(DEFAULT_API_RATE_LIMIT);
    setAllowedIpsText('');
    setExpiryPreset('never');
    setExpiresAt('');
    setError(null);
    setCreated(null);
    setConfirmClose(false);
    onOpenChange(false);
  };

  const requestClose = () => {
    if (created) setConfirmClose(true);
    else resetAndClose();
  };

  const toggleScope = (scope: ApiScope) => {
    setCustomScopes(false);
    setScopes((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]));
  };

  const scopePreset: ScopePreset = customScopes ? 'custom' : matchScopePreset(scopes);
  const applyScopePreset = (value: ScopePreset) => {
    const preset = SCOPE_PRESETS.find((item) => item.value === value);
    if (preset) {
      setScopes([...preset.scopes]);
      setCustomScopes(false);
    } else {
      setCustomScopes(true);
    }
  };

  const presetExpiry =
    expiryPreset === 'never' || expiryPreset === 'custom' ? undefined : expiryFromPreset(expiryPreset, '');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const allowedIps = allowedIpsText.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    if (expiryPreset === 'custom') {
      if (!expiresAt) {
        setError('请选择过期时间，或改选其他有效期');
        return;
      }
      if (new Date(expiresAt).getTime() <= Date.now()) {
        setError('过期时间需晚于当前时间');
        return;
      }
    }
    const parsed = createApiKeyRequestSchema.safeParse({
      name,
      scopes,
      rateLimit,
      allowedIps,
      expiresAt: expiryFromPreset(expiryPreset, expiresAt),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    create.mutate(parsed.data);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="max-w-md" showClose={!created}>
          {created ? (
            <>
              <DialogHeader title="密钥已创建" description="请立即复制并妥善保存，关闭后将无法再次查看。" />
              <DialogBody className="flex flex-col gap-3">
                <div className="flex items-center gap-2 rounded-md border border-caution-soft bg-caution-soft px-3 py-2 text-sm text-caution">
                  <KeyRound className="size-4 shrink-0" />
                  完整密钥仅显示这一次。
                </div>
                <div className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{created.key}</code>
                </div>
                <div>
                  <CopyButton value={created.key} label="复制密钥" />
                </div>
                <CreatedKeyGuide created={created} />
              </DialogBody>
              <DialogFooter>
                <Button onClick={requestClose}>完成</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader title="创建 API 密钥" />
              <form onSubmit={handleSubmit}>
                <DialogBody className="flex flex-col gap-4">
                  <FormField label="名称" required>
                    {(field) => (
                      <Input
                        {...field}
                        maxLength={64}
                        placeholder="例如 自动化脚本"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    )}
                  </FormField>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-ink">权限范围</span>
                    <SegmentedControl
                      aria-label="权限预设"
                      value={scopePreset}
                      onValueChange={applyScopePreset}
                      options={[
                        ...SCOPE_PRESETS.map(({ value, label }) => ({ value, label })),
                        { value: 'custom' as const, label: '自定义' },
                      ]}
                      className="w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:px-2"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      {API_SCOPES.map((scope) => (
                        <label
                          key={scope}
                          className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm text-ink"
                        >
                          <Checkbox checked={scopes.includes(scope)} onCheckedChange={() => toggleScope(scope)} />
                          {SCOPE_LABELS[scope]}
                        </label>
                      ))}
                    </div>
                  </div>
                  <FormField label="速率限制" description="每分钟最大请求数">
                    {(field) => (
                      <Input
                        {...field}
                        type="number"
                        min={1}
                        max={MAX_API_RATE_LIMIT}
                        value={rateLimit}
                        onChange={(event) => setRateLimit(Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField label="IP 白名单" description="逗号或换行分隔的 IP / CIDR，留空则不限制">
                    {(field) => (
                      <Input
                        {...field}
                        placeholder="203.0.113.5, 10.0.0.0/24"
                        value={allowedIpsText}
                        onChange={(event) => setAllowedIpsText(event.target.value)}
                      />
                    )}
                  </FormField>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-ink">有效期</span>
                    <SegmentedControl
                      aria-label="有效期"
                      value={expiryPreset}
                      onValueChange={setExpiryPreset}
                      options={EXPIRY_OPTIONS}
                      className="w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:px-2"
                    />
                    {expiryPreset === 'custom' ? (
                      <Input
                        aria-label="自定义过期时间"
                        type="datetime-local"
                        value={expiresAt}
                        onChange={(event) => setExpiresAt(event.target.value)}
                      />
                    ) : (
                      <p className="text-xs text-ink-tertiary">
                        {presetExpiry ? `将于 ${formatDateTime(presetExpiry)} 过期` : '密钥长期有效，可随时停用或删除。'}
                      </p>
                    )}
                  </div>
                  {error && <p role="alert" className="text-sm text-critical">{error}</p>}
                </DialogBody>
                <DialogFooter>
                  <Button type="button" variant="secondary" onClick={requestClose}>
                    取消
                  </Button>
                  <Button type="submit" loading={create.isPending} disabled={scopes.length === 0}>
                    创建
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="确认已保存密钥？"
        description="关闭后将无法再次查看完整密钥。"
        confirmLabel="已保存，关闭"
        onConfirm={() => {
          toast({ title: 'API 密钥已创建', variant: 'success' });
          resetAndClose();
        }}
      />
    </>
  );
}
