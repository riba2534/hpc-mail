import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
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
import { toast } from '@/components/ui/toast';

const SCOPE_LABELS: Record<ApiScope, string> = {
  'mail.read': '读取邮件',
  'mail.write': '标记已读/删除',
  'mail.send': '发送邮件',
  'mailbox.read': '读取邮箱',
  'mailbox.write': '管理邮箱',
};

export function CreateApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [rateLimit, setRateLimit] = useState(DEFAULT_API_RATE_LIMIT);
  const [allowedIpsText, setAllowedIpsText] = useState('');
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
    setScopes([]);
    setRateLimit(DEFAULT_API_RATE_LIMIT);
    setAllowedIpsText('');
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
    setScopes((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]));
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const allowedIps = allowedIpsText.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    const parsed = createApiKeyRequestSchema.safeParse({
      name,
      scopes,
      rateLimit,
      allowedIps,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
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
                <CopyButton value={created.key} label="复制密钥" />
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
                  <FormField label="过期时间" description="留空则永不过期">
                    {(field) => (
                      <Input
                        {...field}
                        type="datetime-local"
                        value={expiresAt}
                        onChange={(event) => setExpiresAt(event.target.value)}
                      />
                    )}
                  </FormField>
                  {error && <p className="text-sm text-critical">{error}</p>}
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
