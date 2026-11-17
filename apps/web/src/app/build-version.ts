import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { dismissToast, toast } from '@/components/ui/toast';

/** 本页前端的构建号（vite.config.ts 注入）；测试等未注入的环境视为本地构建 */
export const CLIENT_BUILD = typeof __HPC_BUILD__ === 'string' ? __HPC_BUILD__ : 'local';

/** 首次检查避开启动时的请求高峰；之后每 30 分钟查一次，切回标签页且距上次超过 5 分钟时也查 */
export const FIRST_CHECK_DELAY_MS = 5_000;
export const CHECK_INTERVAL_MS = 30 * 60_000;
export const MIN_CHECK_GAP_MS = 5 * 60_000;
/** 提示一直留着，直到用户刷新或关闭 */
const PROMPT_DURATION_MS = 60 * 60_000;
const RELOADED_FOR_KEY = 'hpc-mail:build-reloaded-for';

const isReleaseBuild = (build: string | null | undefined): build is string => Boolean(build) && build !== 'local';

/** 前端与线上都是正式构建且构建号不同，才算本页已过期；任一方是 local 或取不到都不判定 */
export function isStaleBuild(client: string, server: string | null | undefined): boolean {
  return isReleaseBuild(client) && isReleaseBuild(server) && client !== server;
}

/** 线上构建号：/api/config 的 X-HPC-Build 响应头。只读响应头，不经浏览器缓存 */
export async function fetchServerBuild(): Promise<string | null> {
  const response = await fetch('/api/config', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  response.body?.cancel().catch(() => {});
  return response.ok ? response.headers.get('X-HPC-Build') : null;
}

function reloadedFor(server: string): boolean {
  try {
    return globalThis.sessionStorage.getItem(RELOADED_FOR_KEY) === server;
  } catch {
    return false;
  }
}

/**
 * 整页加载到新版本。每个线上构建号在本标签页只自动刷新一次：刷新后仍不一致（外壳缓存尚未更新等）时
 * 不再刷新，避免之后每次切页都整页重载；离线或存储不可用时不刷新。返回是否发起了刷新。
 */
export function reloadForNewBuild(server: string, reload: () => void): boolean {
  if (globalThis.navigator?.onLine === false || reloadedFor(server)) return false;
  try {
    globalThis.sessionStorage.setItem(RELOADED_FOR_KEY, server);
  } catch {
    return false;
  }
  reload();
  return true;
}

const reloadPage = () => globalThis.location.reload();

/**
 * 长期打开的标签页感知发版：线上构建号与本页不同时提示刷新，并在下一次切换页面时整页加载新版本
 * （切页是天然的边界，不会打断正在填写的表单）。本地构建不检查。
 */
export function useBuildVersionCheck(clientBuild: string = CLIENT_BUILD, reload: () => void = reloadPage): void {
  const { pathname } = useLocation();
  const [serverBuild, setServerBuild] = useState<string | null>(null);

  useEffect(() => {
    if (!isReleaseBuild(clientBuild)) return;
    let active = true;
    let lastCheck = Number.NEGATIVE_INFINITY;
    const check = () => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastCheck < MIN_CHECK_GAP_MS) return;
      lastCheck = now;
      fetchServerBuild().then(
        (build) => {
          if (active && isStaleBuild(clientBuild, build)) setServerBuild(build);
        },
        () => {
          // 网络失败：下一次再查
        },
      );
    };
    const first = globalThis.setTimeout(check, FIRST_CHECK_DELAY_MS);
    const interval = globalThis.setInterval(check, CHECK_INTERVAL_MS);
    globalThis.document?.addEventListener('visibilitychange', check);
    return () => {
      active = false;
      globalThis.clearTimeout(first);
      globalThis.clearInterval(interval);
      globalThis.document?.removeEventListener('visibilitychange', check);
    };
  }, [clientBuild]);

  useEffect(() => {
    // 已为这个版本自动刷新过仍不一致：刷新解决不了，不再提示
    if (!serverBuild || reloadedFor(serverBuild)) return;
    const id = toast({
      title: '网站已更新',
      description: '刷新页面即可使用新版本，切换页面时也会自动刷新。',
      duration: PROMPT_DURATION_MS,
      action: { label: '刷新', onClick: reload },
    });
    return () => dismissToast(id);
  }, [serverBuild, reload]);

  const serverBuildRef = useRef(serverBuild);
  serverBuildRef.current = serverBuild;
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    if (pathnameRef.current === pathname) return;
    pathnameRef.current = pathname;
    if (serverBuildRef.current) reloadForNewBuild(serverBuildRef.current, reload);
  }, [pathname, reload]);
}
