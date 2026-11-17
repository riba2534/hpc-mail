import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { changePasswordRequestSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { getAuthRevision, setAuthToken } from '@/lib/auth-token';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { PasswordInput } from '@/components/ui/password-input';
import { toast } from '@/components/ui/toast';

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // 默认一并吊销：账号可能已泄露时，改密之外还要收回别人可能留下的 API Key
  const [revokeApiKeys, setRevokeApiKeys] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => authApi.changePassword({ oldPassword, newPassword, revokeApiKeys }),
    onSuccess: (res) => {
      // 改密会踢掉全部旧会话，服务端返回的新 token 需立即替换，当前会话才不掉线。
      // 同一账户换发 token 不清查询缓存；预填新一代会话，外壳与当前页面不重挂、不闪全屏加载
      setAuthToken(res.token);
      queryClient.setQueryData(queryKeys.sessionForRevision(getAuthRevision()), res.user);
      toast({
        title: '密码已修改',
        description: res.revokedApiKeys > 0 ? `已吊销 ${res.revokedApiKeys} 个 API Key，用到它们的脚本需要换用新 Key` : undefined,
        variant: 'success',
      });
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '修改失败，请重试'),
  });

  const reset = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirm('');
    setRevokeApiKeys(true);
    setError(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    const parsed = changePasswordRequestSchema.safeParse({ oldPassword, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader title="修改密码" />
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <FormField label="当前密码" required>
              {(field) => (
                <PasswordInput
                  {...field}
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="新密码" description="至少 8 位" required>
              {(field) => (
                <PasswordInput
                  {...field}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="确认新密码" required error={error ?? undefined}>
              {(field) => (
                <PasswordInput
                  {...field}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              )}
            </FormField>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={revokeApiKeys}
                onCheckedChange={(checked) => setRevokeApiKeys(checked === true)}
              />
              <span className="min-w-0">
                <span className="font-medium text-ink">同时吊销我的全部 API Key</span>
                <span className="mt-0.5 block text-ink-tertiary">
                  怀疑账号泄露时建议勾选。吊销后，使用这些 Key 的脚本和 AI Agent 立即失效，需要到「API Keys」页重新创建。
                </span>
              </span>
            </label>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
