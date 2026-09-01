import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  type LoginResponse,
  loginRequestSchema,
  registerRequestSchema,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { GITHUB_REPO_URL, GithubIcon } from '@/components/ui/github-link';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast';
import { setAuthToken } from '@/lib/auth-token';
import { usePublicConfig } from '@/lib/use-config';
import { useAuthToken } from '@/lib/use-session';

type Mode = 'login' | 'register';

export function LoginPage() {
  const token = useAuthToken();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: config, isLoading: configLoading } = usePublicConfig();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromState = (location.state as { from?: string } | null)?.from;
  const redirectTo = fromState && fromState !== '/login' ? fromState : '/inbox';

  const registrationMode = config?.registrationMode ?? 'closed';
  const canRegister = registrationMode !== 'closed';
  const needsInvite = registrationMode === 'invite';

  const applySession = (data: LoginResponse) => {
    setAuthToken(data.token);
    queryClient.setQueryData(queryKeys.session, data.user);
    void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    navigate(redirectTo, { replace: true });
  };

  const loginMutation = useMutation({
    mutationFn: () => authApi.login({ username, password, totp: totp.trim() || undefined }),
    onSuccess: applySession,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setTotpRequired(true);
        setError(totp ? '两步验证码错误' : null);
        return;
      }
      // 已进入 2FA 步骤时，错误多为验证码不对
      setError(err instanceof ApiError ? err.message : '登录失败，请重试');
    },
  });

  const registerMutation = useMutation({
    mutationFn: () =>
      authApi.register({ username, password, inviteCode: needsInvite ? inviteCode : undefined }),
    onSuccess: (data) => {
      if (data?.token) {
        applySession(data);
        return;
      }
      toast({ title: '注册成功，请登录', variant: 'success' });
      setMode('login');
      setPassword('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '注册失败，请重试'),
  });

  if (token) return <Navigate to={redirectTo} replace />;

  const pending = loginMutation.isPending || registerMutation.isPending;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === 'login') {
      const parsed = loginRequestSchema.safeParse({ username, password, totp: totp || undefined });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查输入');
        return;
      }
      loginMutation.mutate();
    } else {
      const parsed = registerRequestSchema.safeParse({
        username,
        password,
        inviteCode: needsInvite ? inviteCode : undefined,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? '请检查输入');
        return;
      }
      if (needsInvite && !inviteCode.trim()) {
        setError('请输入邀请码');
        return;
      }
      registerMutation.mutate();
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="" className="size-12 rounded-lg" />
          <h1 className="text-lg font-semibold text-ink">{config?.siteTitle ?? 'HPC Mail'}</h1>
        </div>

        <div className="rounded-lg border border-line bg-surface p-6 shadow-xs">
          {canRegister && (
            <SegmentedControl
              aria-label="账户操作"
              value={mode}
              onValueChange={(value) => switchMode(value as Mode)}
              options={[
                { value: 'login', label: '登录' },
                { value: 'register', label: '注册' },
              ]}
              className="mb-5 w-full [&>button]:flex-1"
            />
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <FormField label="用户名" required>
              {(field) => (
                <Input
                  {...field}
                  autoComplete="username"
                  placeholder="小写字母/数字，3-32 位"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="密码" required>
              {(field) => (
                <PasswordInput
                  {...field}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'register' ? '至少 8 位' : '请输入密码'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </FormField>
            {mode === 'register' && needsInvite && (
              <FormField label="邀请码" required>
                {(field) => (
                  <Input
                    {...field}
                    placeholder="请输入邀请码"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                  />
                )}
              </FormField>
            )}
            {mode === 'login' && totpRequired && (
              <FormField label="两步验证码" required>
                {(field) => (
                  <Input
                    {...field}
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6 位验证码或恢复码"
                    value={totp}
                    onChange={(event) => setTotp(event.target.value)}
                  />
                )}
              </FormField>
            )}

            {error && <p className="text-sm text-critical">{error}</p>}

            <Button type="submit" loading={pending} disabled={configLoading} className="mt-1 w-full">
              {mode === 'login' ? '登录' : '注册并登录'}
            </Button>
          </form>
        </div>

        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-tertiary transition-colors hover:text-ink"
        >
          <GithubIcon className="size-3.5" />
          开源于 GitHub
        </a>
      </div>
    </div>
  );
}
