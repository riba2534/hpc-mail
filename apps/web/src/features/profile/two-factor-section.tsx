import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import type { SessionUser, TwoFactorSetup } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton, useCopy } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { toast } from '@/components/ui/toast';
import { useCurrentUser } from '@/lib/use-session';
import { QrCode } from './qr-code';

/** 恢复码 .txt 的内容：带账户与时间，方便日后辨认 */
export function recoveryCodesText(username: string, codes: string[], now = new Date()): string {
  return [
    'HPC Mail 两步验证恢复码',
    `账户：${username}`,
    `生成时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
    '每个恢复码只能使用一次，可在丢失 Authenticator 时代替验证码登录。',
    '',
    ...codes,
    '',
  ].join('\n');
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const user = useCurrentUser();
  const { copied, copy } = useCopy('恢复码已复制');
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const close = () => {
    setSaved(false);
    setConfirmOpen(false);
    onClose();
  };
  // 没复制也没下载就关闭时多问一句：恢复码此后不再展示
  const requestClose = () => (saved ? close() : setConfirmOpen(true));

  const text = recoveryCodesText(user.username, codes ?? []);

  return (
    <>
      <Dialog open={codes !== null} onOpenChange={(next) => !next && requestClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader title="保存恢复码" description="每个恢复码可在丢失设备时登录一次，请妥善保存——此后不再展示。" />
          <DialogBody>
            <div className="grid grid-cols-2 gap-2">
              {(codes ?? []).map((rc) => (
                <code key={rc} className="rounded-md border border-line bg-canvas px-2 py-1.5 text-center font-mono text-sm text-ink">
                  {rc}
                </code>
              ))}
            </div>
          </DialogBody>
          <DialogFooter className="flex-wrap">
            <Button
              variant="secondary"
              onClick={() => {
                downloadText(`hpc-mail-recovery-codes-${user.username}.txt`, text);
                setSaved(true);
              }}
            >
              <Download className="size-4" />
              下载 .txt
            </Button>
            <Button
              variant="secondary"
              onClick={() => void copy((codes ?? []).join('\n')).then((ok) => ok && setSaved(true))}
            >
              {copied ? <Check className="size-4 text-positive" /> : <Copy className="size-4" />}
              {copied ? '已复制' : '复制全部'}
            </Button>
            <Button onClick={requestClose}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认已保存恢复码？"
        description="你还没有复制或下载恢复码。关闭后将无法再次查看；丢失 Authenticator 又没有恢复码时，将无法自行登录。"
        cancelLabel="返回保存"
        confirmLabel="已保存，关闭"
        onConfirm={close}
      />
    </>
  );
}

function SetupPanel({ setup, onCancel }: { setup: TwoFactorSetup; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const enable = useMutation({
    mutationFn: () => authApi.enable2fa(code.trim()),
    onSuccess: (data) => setRecoveryCodes(data.recoveryCodes),
    onError: (err) => setError(err instanceof ApiError ? err.message : '验证失败'),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError('请输入 Authenticator 显示的 6 位数字');
      return;
    }
    enable.mutate();
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-ink-secondary">
        用 Authenticator（如 Google Authenticator、1Password）扫描二维码；无法扫码时复制密钥手动添加。然后输入生成的 6 位验证码完成启用。
      </p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <QrCode value={setup.otpauthUri} label="两步验证二维码" className="w-44 shrink-0 self-center sm:self-start" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-secondary">密钥</span>
            <code className="break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink">
              {setup.secret}
            </code>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={setup.secret} label="复制密钥" size="sm" />
            <CopyButton value={setup.otpauthUri} label="复制链接" size="sm" />
          </div>
          <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
            <label htmlFor="totp-enable-code" className="text-xs font-medium text-ink-secondary">
              6 位验证码
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="totp-enable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                className="max-w-36"
                value={code}
                invalid={error !== null}
                aria-describedby={error ? 'totp-enable-error' : undefined}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ''));
                  if (error) setError(null);
                }}
              />
              <Button type="submit" size="sm" loading={enable.isPending}>
                验证并启用
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                取消
              </Button>
            </div>
            {error && (
              <p id="totp-enable-error" role="alert" className="text-sm text-critical">
                {error}
              </p>
            )}
          </form>
        </div>
      </div>
      <RecoveryCodesDialog
        codes={recoveryCodes}
        onClose={() => {
          setRecoveryCodes(null);
          // 关掉恢复码后再更新会话：先本地置为已启用避免闪回「未启用」，再以服务端为准
          queryClient.setQueriesData<SessionUser>({ queryKey: queryKeys.session }, (old) =>
            old ? { ...old, twoFactorEnabled: true } : old,
          );
          void queryClient.invalidateQueries({ queryKey: queryKeys.session });
          onCancel();
        }}
      />
    </div>
  );
}

export function TwoFactorSection({ id }: { id?: string }) {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');

  const invalidateSession = () => queryClient.invalidateQueries({ queryKey: queryKeys.session });

  const startSetup = useMutation({
    mutationFn: () => authApi.setup2fa(),
    onSuccess: (data) => setSetup(data),
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '启动失败', variant: 'error' }),
  });

  const disable = useMutation({
    mutationFn: () => authApi.disable2fa({ password: disablePassword || undefined }),
    onSuccess: () => {
      toast({ title: '两步验证已关闭', variant: 'success' });
      setDisableOpen(false);
      setDisablePassword('');
      void invalidateSession();
    },
    onError: (err) => toast({ title: err instanceof ApiError ? err.message : '关闭失败', variant: 'error' }),
  });

  return (
    <section id={id} tabIndex={-1} className="scroll-mt-20 rounded-lg border border-line bg-surface p-5 focus:outline-none">
      <div className="mb-4 flex items-center gap-2">
        {user.twoFactorEnabled ? (
          <ShieldCheck className="size-4 text-positive" />
        ) : (
          <ShieldOff className="size-4 text-ink-tertiary" />
        )}
        <h2 className="text-sm font-semibold text-ink">两步验证（2FA）</h2>
      </div>

      {setup ? (
        <SetupPanel setup={setup} onCancel={() => setSetup(null)} />
      ) : user.twoFactorEnabled ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-secondary">已启用。登录时需额外输入 Authenticator 生成的 6 位验证码。</p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => setDisableOpen(true)}>
              关闭两步验证
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-ink-secondary">
            开启后登录需 Authenticator 验证码，显著提升账户安全（本系统聚合各站验证码，账户价值高，建议开启）。
          </p>
          <div>
            <Button variant="secondary" size="sm" loading={startSetup.isPending} onClick={() => startSetup.mutate()}>
              启用两步验证
            </Button>
          </div>
        </div>
      )}

      {/* 关闭确认 */}
      <Dialog open={disableOpen} onOpenChange={(next) => !next && setDisableOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader title="关闭两步验证" description="请输入当前密码确认。" />
          <DialogBody>
            <PasswordInput
              autoFocus
              aria-label="当前密码"
              placeholder="当前密码"
              value={disablePassword}
              onChange={(event) => setDisablePassword(event.target.value)}
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDisableOpen(false)}>
              取消
            </Button>
            <Button variant="danger" loading={disable.isPending} onClick={() => disable.mutate()}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
