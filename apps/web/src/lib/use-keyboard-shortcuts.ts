import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 有打开的模态层（Dialog/Sheet/菜单）时页面快捷键让位 */
function hasOpenOverlay(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]') !== null;
}

/**
 * 页面级快捷键的统一前置判断：带 Ctrl/⌘/Alt、正在输入、已被别的处理器消费、或有模态层打开时忽略。
 * 列表/详情/写信页的键位处理器应先调用它。
 */
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  return (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isTyping(event.target) ||
    hasOpenOverlay()
  );
}

export const GOTO_SHORTCUTS: Record<string, string> = {
  i: '/inbox',
  s: '/sent',
  t: '/trash',
  r: '/starred',
  m: '/mailboxes',
};

/** 搜索框以该属性标记，`/` 聚焦第一个可见的 */
export const SEARCH_SHORTCUT_ATTR = 'data-shortcut-search';

function focusSearch(): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(`[${SEARCH_SHORTCUT_ATTR}]`);
  for (const el of candidates) {
    if (el.getClientRects().length === 0 && candidates.length > 1) continue;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    return true;
  }
  return false;
}

/**
 * 全局键盘快捷键：c 写信；g 后接 i/s/t/r/m 跳转；/ 聚焦搜索；? 打开帮助。
 * 在捕获阶段处理并消费这些键，页面级处理器（冒泡阶段）不会再收到 g 序列的第二个键。
 */
export function useKeyboardShortcuts({ onHelp }: { onHelp?: () => void } = {}) {
  const navigate = useNavigate();
  const pendingG = useRef(false);
  const helpRef = useRef(onHelp);
  helpRef.current = onHelp;

  useEffect(() => {
    let timer: number | undefined;
    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const handler = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) {
        pendingG.current = false;
        return;
      }

      if (pendingG.current) {
        pendingG.current = false;
        const dest = GOTO_SHORTCUTS[event.key.toLowerCase()];
        if (dest) {
          consume(event);
          navigate(dest);
        }
        return;
      }

      if (event.shiftKey && event.key !== '?') return;
      switch (event.key) {
        case 'g':
          consume(event);
          pendingG.current = true;
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            pendingG.current = false;
          }, 1200);
          return;
        case 'c':
          consume(event);
          navigate('/compose');
          return;
        case '/':
          if (focusSearch()) consume(event);
          return;
        case '?':
          if (helpRef.current) {
            consume(event);
            helpRef.current();
          }
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.clearTimeout(timer);
    };
  }, [navigate]);
}
