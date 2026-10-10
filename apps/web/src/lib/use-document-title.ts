import { useEffect, useSyncExternalStore } from 'react';

/**
 * 页面级标题覆盖：后挂载者优先，卸载时自动出栈。
 * 外壳负责拼成「(未读) 标题 · 站点名」写入 document.title；页面只声明自己的标题。
 */
const stack: { id: number; title: string }[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): string | null {
  return stack.at(-1)?.title ?? null;
}

/** 当前生效的页面标题覆盖（无覆盖为 null），供外壳读取 */
export function useTitleOverride(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 声明当前页面在标签页上的标题，例如邮件详情传入邮件主题。
 * 传 null/undefined/空串时不覆盖，沿用路由默认标题（加载中可先传 null）。
 */
export function useDocumentTitle(title: string | null | undefined): void {
  const value = title?.trim() || null;
  useEffect(() => {
    if (!value) return;
    const entry = { id: nextId++, title: value };
    stack.push(entry);
    emit();
    return () => {
      const index = stack.findIndex((item) => item.id === entry.id);
      if (index >= 0) stack.splice(index, 1);
      emit();
    };
  }, [value]);
}

/** 标签页标题格式：「(45) 收件箱 · HPC Mail」；未读为 0 时省略计数 */
export function formatDocumentTitle(pageTitle: string | null, siteTitle: string, unread = 0): string {
  const count = unread > 0 ? `(${unread > 999 ? '999+' : unread}) ` : '';
  return pageTitle ? `${count}${pageTitle} · ${siteTitle}` : `${count}${siteTitle}`;
}
