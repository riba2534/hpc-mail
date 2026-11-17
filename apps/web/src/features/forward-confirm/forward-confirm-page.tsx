import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/api/errors';
import { notifyPrefsApi } from '@/api/resources';
import logoUrl from '@/assets/logo.webp';
import { Button } from '@/components/ui/button';

/** 确认信里的链接把 token 放在 # 之后：不进服务器日志与 Referer */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
}

/**
 * 转发目标确认页（公开，不需要登录）：目标邮箱的主人点按钮才确认。
 * 不在打开页面时自动确认——邮件客户端或链接预览会预先打开链接，不能因此替对方同意。
 */
export function ForwardConfirmPage() {
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const confirm = useMutation({ mutationFn: () => notifyPrefsApi.confirmForward(token) });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 text-sm">
        <img src={logoUrl} alt="" className="mb-4 size-9 rounded-md" />
        <h1 className="text-base font-semibold text-ink">确认接收邮件转发</h1>
        {!token ? (
          <p role="alert" className="mt-3 text-critical">链接不完整，请从确认邮件里重新打开。</p>
        ) : confirm.isSuccess ? (
          <p role="status" className="mt-3 text-ink-secondary">
            已确认。之后 {confirm.data.address} 会收到对方邮箱转发来的邮件；不想再收时请联系对方在 HPC Mail 里删除这个转发目标。
          </p>
        ) : (
          <>
            <p className="mt-3 text-ink-secondary">
              有 HPC Mail 用户请求把其邮箱收到的邮件转发到你的邮箱。只有你点下面的按钮才会开始转发；不认识这个请求就关掉本页。
            </p>
            {confirm.isError && (
              <p role="alert" className="mt-3 text-critical">
                {confirm.error instanceof ApiError ? confirm.error.message : '确认失败，请稍后重试'}
              </p>
            )}
            <Button className="mt-5 w-full" loading={confirm.isPending} onClick={() => confirm.mutate()}>
              同意接收转发
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
