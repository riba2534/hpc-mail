import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, LogOut, RefreshCw } from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { clearAuthToken } from '@/lib/auth-token';
import { CurrentUserContext, useAuthToken, useSessionQuery } from '@/lib/use-session';
import { AppShell } from './app-shell';
import { FullScreenLoader } from './page-loader';

export function AuthGuard() {
  const token = useAuthToken();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { data: user, isLoading, isFetching, isError, error, refetch } = useSessionQuery();

  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (isLoading) return <FullScreenLoader />;
  if (isError || !user) {
    const disabled = error instanceof ApiError && error.code === 'user_disabled';
    const logout = () => {
      clearAuthToken();
      queryClient.clear();
    };
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
        <section className="w-full max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-xs">
          <div className="mx-auto grid size-11 place-items-center rounded-full bg-critical-soft text-critical">
            <AlertCircle className="size-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-ink">
            {disabled ? '账号已被禁用' : '暂时无法加载账户'}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {disabled
              ? '当前账户无法继续访问，请联系管理员恢复后重新登录。'
              : '登录状态仍保留。请检查网络后重试，或退出并重新登录。'}
          </p>
          {error instanceof ApiError && error.requestId && (
            <p className="mt-2 text-xs text-ink-tertiary">请求编号：{error.requestId}</p>
          )}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {!disabled && (
              <Button variant="secondary" loading={isFetching} onClick={() => void refetch()}>
                <RefreshCw className="size-4" />
                重新加载
              </Button>
            )}
            <Button variant={disabled ? 'danger' : 'ghost'} onClick={logout}>
              <LogOut className="size-4" />
              退出登录
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <CurrentUserContext.Provider value={user}>
      <AppShell />
    </CurrentUserContext.Provider>
  );
}
