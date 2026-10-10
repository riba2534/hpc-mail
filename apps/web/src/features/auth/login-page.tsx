import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { LoginResponse } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { prefetchAuthedRoute } from '@/app/boot-prefetch';
import logoUrl from '@/assets/logo.webp';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { GITHUB_REPO_URL, GithubIcon } from '@/components/ui/github-link';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast';
import { getAuthRevision, setAuthToken } from '@/lib/auth-token';
import { usePublicConfig } from '@/lib/use-config';
import { useAuthToken } from '@/lib/use-session';

type Mode = 'login' | 'register';
type Field = 'username' | 'password' | 'confirmPassword' | 'inviteCode' | 'totp';
type FieldErrors = Partial<Record<Field, string>>;

const CONTRACT_FIELDS: ReadonlySet<string> = new Set<Field>(['username', 'password', 'inviteCode', 'totp']);

/** zod 校验问题按字段归位；归不到字段的第一条作为表单级错误 */
function mapIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): {
  fields: FieldErrors;
  form: string | null;
} {
  const fields: FieldErrors = {};
  let form: string | null = null;
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && CONTRACT_FIELDS.has(key)) {
      fields[key as Field] ??= issue.message;
    } else {
      form ??= issue.message;
    }
  }
  return { fields, form };
}

// zod 契约只在提交时用于前置校验：不进登录首屏，输入框聚焦时预取；加载失败允许重试
let contractPromise: Promise<typeof import('@hpc-mail/shared')> | undefined;
function loadContract() {
  contractPromise ??= import('@hpc-mail/shared').catch((error: unknown) => {
    contractPromise = undefined;
    throw error;
  });
  return contractPromise;
}
const preloadContract = () => void loadContract().catch(() => {});

export function LoginPage() {
  const token = useAuthToken();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: config, isLoading: configLoading } = usePublicConfig();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [validating, setValidating] = useState(false);

  const fromState = (location.state as { from?: string } | null)?.from;
  const redirectTo = fromState && fromState !== '/login' ? fromState : '/inbox';

  const registrationMode = config?.registrationMode ?? 'closed';
  const canRegister = registrationMode !== 'closed';
  const needsInvite = registrationMode === 'invite';

  const applySession = (data: LoginResponse) => {
    queryClient.clear();
    setAuthToken(data.token);
    queryClient.setQueryData(queryKeys.sessionForRevision(getAuthRevision()), data.user);
    void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    const target = new URL(redirectTo, globalThis.location.origin);
    prefetchAuthedRoute(queryClient, target.pathname, target.search);
    navigate(redirectTo, { replace: true });
  };

  const loginMutation = useMutation({
    mutationFn: () => authApi.login({ username, password, totp: totp.trim() || undefined }),
    onSuccess: applySession,
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setTotpRequired(true);
        setError(null);
        if (totp) setFieldErrors({ totp: '两步验证码错误' });
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
      setConfirmPassword('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '注册失败，请重试'),
  });

  if (token) return <Navigate to={redirectTo} replace />;

  const pending = loginMutation.isPending || registerMutation.isPending || validating;

  const clearFieldError = (field: Field) =>
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  /** 不依赖契约的前置检查：空字段与两次密码一致性，立即提示 */
  const checkRequired = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!username.trim()) errors.username = '请输入用户名';
    if (!password) errors.password = '请输入密码';
    if (mode === 'login') {
      if (totpRequired && !totp.trim()) errors.totp = '请输入两步验证码';
    } else {
      if (!confirmPassword) errors.confirmPassword = '请再次输入密码';
      else if (confirmPassword !== password) errors.confirmPassword = '两次输入的密码不一致';
      if (needsInvite && !inviteCode.trim()) errors.inviteCode = '请输入邀请码';
    }
    return errors;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    const required = checkRequired();
    setFieldErrors(required);
    if (Object.keys(required).length > 0) return;

    setValidating(true);
    // 契约加载失败时跳过前置校验，由服务端校验兜底
    const contract = await loadContract().catch(() => null);
    setValidating(false);
    const parsed =
      mode === 'login'
        ? contract?.loginRequestSchema.safeParse({ username, password, totp: totp || undefined })
        : contract?.registerRequestSchema.safeParse({
            username,
            password,
            inviteCode: needsInvite ? inviteCode : undefined,
          });
    if (parsed && !parsed.success) {
      const mapped = mapIssues(parsed.error.issues);
      setFieldErrors(mapped.fields);
      setError(mapped.form ?? (Object.keys(mapped.fields).length > 0 ? null : '请检查输入'));
      return;
    }
    if (mode === 'login') loginMutation.mutate();
    else registerMutation.mutate();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setFieldErrors({});
    setConfirmPassword('');
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src={logoUrl} alt="" className="size-12 rounded-lg" />
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

          <form onSubmit={handleSubmit} onFocus={preloadContract} className="flex flex-col gap-4">
            <FormField label="用户名" required error={fieldErrors.username}>
              {(field) => (
                <Input
                  {...field}
                  autoComplete="username"
                  placeholder="小写字母/数字，3-32 位"
                  value={username}
                  invalid={Boolean(fieldErrors.username)}
                  onChange={(event) => {
                    setUsername(event.target.value);
                    clearFieldError('username');
                  }}
                />
              )}
            </FormField>
            <FormField label="密码" required error={fieldErrors.password}>
              {(field) => (
                <PasswordInput
                  {...field}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'register' ? '至少 8 位' : '请输入密码'}
                  value={password}
                  invalid={Boolean(fieldErrors.password)}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearFieldError('password');
                  }}
                />
              )}
            </FormField>
            {mode === 'register' && (
              <FormField label="确认密码" required error={fieldErrors.confirmPassword}>
                {(field) => (
                  <PasswordInput
                    {...field}
                    autoComplete="new-password"
                    placeholder="再次输入密码"
                    value={confirmPassword}
                    invalid={Boolean(fieldErrors.confirmPassword)}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      clearFieldError('confirmPassword');
                    }}
                  />
                )}
              </FormField>
            )}
            {mode === 'register' && needsInvite && (
              <FormField label="邀请码" required error={fieldErrors.inviteCode}>
                {(field) => (
                  <Input
                    {...field}
                    placeholder="请输入邀请码"
                    value={inviteCode}
                    invalid={Boolean(fieldErrors.inviteCode)}
                    onChange={(event) => {
                      setInviteCode(event.target.value);
                      clearFieldError('inviteCode');
                    }}
                  />
                )}
              </FormField>
            )}
            {mode === 'login' && totpRequired && (
              <FormField label="两步验证码" required error={fieldErrors.totp}>
                {(field) => (
                  <Input
                    {...field}
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6 位验证码或恢复码"
                    value={totp}
                    invalid={Boolean(fieldErrors.totp)}
                    onChange={(event) => {
                      setTotp(event.target.value);
                      clearFieldError('totp');
                    }}
                  />
                )}
              </FormField>
            )}

            {error && <p role="alert" className="text-sm text-critical">{error}</p>}

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
    </main>
  );
}
