import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { ApiError, isFetchFailure } from '@/api/errors';
import { Button } from '@/components/ui/button';

/**
 * 动态 import 的 chunk 取不到时各浏览器的报错：
 * Chrome「Failed to fetch dynamically imported module」、Firefox「error loading dynamically imported module」、
 * Safari「Importing a module script failed」、Vite 预加载 CSS 失败「Unable to preload CSS」。
 */
const CHUNK_LOAD_FAILURE =
  /dynamically imported module|importing a module script failed|unable to preload css|loading (?:css )?chunk \S+ failed/i;

export type RouteErrorKind = 'chunk' | 'network' | 'other';

/** 资源加载失败与网络失败给出中文友好提示；其余错误沿用原展示 */
export function classifyRouteError(error: unknown): RouteErrorKind {
  if (error instanceof Error && (error.name === 'ChunkLoadError' || CHUNK_LOAD_FAILURE.test(error.message))) {
    return 'chunk';
  }
  if (isFetchFailure(error) || (error instanceof ApiError && (error.code === 'network' || error.code === 'timeout'))) {
    return 'network';
  }
  return 'other';
}

function technicalDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * 路由错误的说明区（图标、标题、说明与技术细节）。根错误页整屏显示并提供刷新；
 * 外壳内的页面错误只替换主内容区，操作按钮由调用方给出。
 */
export function RouteErrorView({ className, actions }: { className: string; actions: ReactNode }) {
  const error = useRouteError();
  const kind = isRouteErrorResponse(error) ? 'other' : classifyRouteError(error);
  const offline = globalThis.navigator?.onLine === false;

  let title: string;
  let message: string;
  if (kind === 'chunk') {
    title = '页面资源加载失败';
    message = offline
      ? '当前网络已断开，恢复连接后刷新页面即可。'
      : '可能是网站刚刚更新或网络不稳定，刷新页面即可加载最新版本。';
  } else if (kind === 'network') {
    title = '网络连接失败';
    message = offline ? '当前网络已断开，恢复连接后刷新页面即可。' : '暂时无法连接到服务器，请检查网络后刷新页面。';
  } else if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    message = '请求的页面无法加载。';
  } else {
    title = '页面出错了';
    message = error instanceof Error ? error.message : '发生了未知错误，请重试。';
  }

  const friendly = kind !== 'other';
  const Icon = kind === 'network' || offline ? WifiOff : friendly ? RefreshCw : AlertTriangle;

  return (
    <div className={`grid place-items-center px-6 ${className}`}>
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div
          className={
            friendly
              ? 'grid size-12 place-items-center rounded-full bg-caution-soft text-caution'
              : 'grid size-12 place-items-center rounded-full bg-critical-soft text-critical'
          }
        >
          <Icon className="size-6" />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          <p className="text-sm text-ink-secondary">{message}</p>
        </div>
        {actions}
        {friendly && (
          <details className="w-full rounded-md border border-line bg-surface text-left text-xs">
            <summary className="cursor-pointer select-none px-3 py-2 text-ink-tertiary">技术细节</summary>
            <p className="break-all border-t border-line px-3 py-2 text-ink-secondary">
              {technicalDetail(error)}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}

/** 根路由错误页：外壳本身没能渲染（外壳 chunk 加载失败、登录页出错等），整屏显示 */
export function RouteErrorPage() {
  return (
    <RouteErrorView
      className="min-h-dvh bg-canvas"
      actions={<Button onClick={() => globalThis.location.reload()}>刷新页面</Button>}
    />
  );
}
