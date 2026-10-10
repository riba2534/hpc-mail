/** 可预热的模块加载器：同一 import() 只发起一次；加载完成后可同步取到模块，渲染时无需再挂起。 */
export interface ModuleLoader<M> {
  (): Promise<M>;
  peek(): M | undefined;
}

export function preloadable<M>(importer: () => Promise<M>): ModuleLoader<M> {
  let module: M | undefined;
  let pending: Promise<M> | undefined;
  const load = () =>
    (pending ??= importer().then(
      (loaded) => (module = loaded),
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    ));
  return Object.assign(load, { peek: () => module });
}

/** 路由 chunk 加载器的唯一登记处：路由渲染、启动预取、空闲预取共用，命中同一个模块。 */
export const loadAppShell = preloadable(() => import('./app-shell'));
export const loadInboxPage = preloadable(() => import('@/features/inbox/inbox-page'));
export const loadMessagePage = preloadable(() => import('@/features/message/message-page'));
export const loadComposePage = preloadable(() => import('@/features/compose/compose-page'));
export const loadSentPage = preloadable(() => import('@/features/sent/sent-page'));
export const loadStarredPage = preloadable(() => import('@/features/starred/starred-page'));
export const loadTrashPage = preloadable(() => import('@/features/trash/trash-page'));
export const loadMailboxesPage = preloadable(() => import('@/features/mailboxes/mailboxes-page'));
export const loadApiKeysPage = preloadable(() => import('@/features/api-keys/api-keys-page'));
export const loadProfilePage = preloadable(() => import('@/features/profile/profile-page'));

const ROUTE_LOADERS: ReadonlyArray<readonly [RegExp, () => Promise<unknown>]> = [
  [/^\/(?:inbox)?$/, loadInboxPage],
  [/^\/mail\/\d+$/, loadMessagePage],
  [/^\/compose$/, loadComposePage],
  [/^\/sent$/, loadSentPage],
  [/^\/starred$/, loadStarredPage],
  [/^\/trash$/, loadTrashPage],
  [/^\/mailboxes$/, loadMailboxesPage],
  [/^\/api-keys$/, loadApiKeysPage],
  [/^\/profile$/, loadProfilePage],
];

/** 去掉结尾斜杠（路由匹配对其宽松） */
export const normalizePathname = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);

/** 当前路径对应的页面 chunk（管理页等低频路由不在此列，照常按需加载） */
export function routeLoaderFor(pathname: string): (() => Promise<unknown>) | undefined {
  const normalized = normalizePathname(pathname);
  return ROUTE_LOADERS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** 预热 chunk：失败静默，真正渲染时由 lazyWithReload 处理 */
export function warmModule(load: () => Promise<unknown>): void {
  load().catch(() => {});
}
