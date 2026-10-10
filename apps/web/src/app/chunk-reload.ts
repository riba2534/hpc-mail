import { type ComponentType, createElement, type ReactNode, useEffect, useState } from 'react';
import type { ModuleLoader } from './route-modules';

const RELOAD_STAMP_KEY = 'hpc-mail:chunk-reload-at';
/** 刷新后这段时间内再失败视为持续故障，不再自动刷新，交给错误页 */
const RELOAD_COOLDOWN_MS = 30_000;
let reloading = false;
let staleBuildDetected = false;

const isOffline = () => globalThis.navigator?.onLine === false;

/**
 * 发版后旧页面引用的 chunk 已不存在：自动刷新一次换到新版本。
 * sessionStorage 记录上次自动刷新时间，冷却期内不重复刷新（存储不可用时不刷新），杜绝刷新死循环；
 * 长期打开的标签页在之后的发版中仍能再自愈一次。离线时的失败不是发版导致，刷新只会落到浏览器断网页，不刷新。
 * 返回 true 表示已发起刷新。
 */
export function reloadForStaleChunk(
  reload: () => void = () => globalThis.location.reload(),
  now = Date.now(),
): boolean {
  if (reloading) return true;
  if (isOffline()) return false;
  try {
    const last = Number(globalThis.sessionStorage.getItem(RELOAD_STAMP_KEY));
    if (last && now - last < RELOAD_COOLDOWN_MS) return false;
    globalThis.sessionStorage.setItem(RELOAD_STAMP_KEY, String(now));
  } catch {
    return false;
  }
  reloading = true;
  reload();
  return true;
}

/**
 * Vite 的 import() 包装在任何 chunk 加载失败时派发 vite:preloadError，随后把错误交还调用方。
 * 这里只记下「版本已过期」，不就地刷新：后台预热（登录页契约、空闲预取）失败时立即刷新会打断正在输入的表单。
 * 渲染所需的加载由 lazyWithReload 自行刷新；后台发现的过期在下一次切换页面时整页加载新版本。
 */
export function installChunkReloadHandler(): void {
  globalThis.addEventListener?.('vite:preloadError', () => {
    if (!isOffline()) staleBuildDetected = true;
  });
}

/**
 * 按需加载的组件。不用 React.lazy/Suspense：已预热的模块在首次渲染就同步可用，
 * 未就绪时渲染 fallback，就绪后普通更新替换——避开 Suspense 揭示内容的 300ms 节流。
 * 加载失败先自动刷新一次（刷新进行中保持 fallback），仍失败则抛给路由错误边界。
 */
export function lazyWithReload<M, P extends object>(
  load: ModuleLoader<M>,
  pick: (module: M) => ComponentType<P>,
  fallback: ReactNode = null,
): ComponentType<P> {
  function LazyModule(props: P) {
    const [module, setModule] = useState(load.peek);
    const [failure, setFailure] = useState<{ error: unknown } | null>(null);
    // 切换页面是自然边界：此前后台加载已发现版本过期，就整页加载到新版本
    useEffect(() => {
      if (staleBuildDetected) reloadForStaleChunk();
    }, []);
    useEffect(() => {
      if (module) return;
      let active = true;
      load().then(
        (loaded) => {
          if (active) setModule(() => loaded);
        },
        (error: unknown) => {
          if (active && !reloadForStaleChunk()) setFailure({ error });
        },
      );
      return () => {
        active = false;
      };
    }, [module]);
    if (failure) throw failure.error;
    if (!module) return fallback;
    return createElement(pick(module), props);
  }
  return LazyModule;
}
