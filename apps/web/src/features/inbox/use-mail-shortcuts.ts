import { useEffect, useRef } from 'react';
import { shouldIgnoreShortcut } from '@/lib/use-keyboard-shortcuts';

/** 形如 'j'、'Enter'、'Escape'、'#'、'Shift+U' 的键位 → 处理函数；返回 false 表示不处理，保留浏览器默认行为 */
export type ShortcutMap = Partial<Record<string, (event: KeyboardEvent) => void | boolean>>;

/** 键盘事件 → 键位名：字母统一小写，Shift+字母记为 'Shift+X'；其余按 event.key */
export function shortcutKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): string {
  if (/^[a-z]$/i.test(event.key)) return event.shiftKey ? `Shift+${event.key.toUpperCase()}` : event.key.toLowerCase();
  return event.key;
}

/**
 * 页面级单键快捷键（冒泡阶段）。忽略规则与全局快捷键一致（输入框内、带 Ctrl/⌘/Alt、已被消费、有浮层），
 * 另外下拉列表展开或输入法组字时也不触发。全局的 c、g 序列、/、? 在捕获阶段先被消费，不会到这里。
 */
export function useMailShortcuts(map: ShortcutMap, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event) || event.isComposing || document.querySelector('[role="listbox"]')) return;
      const action = mapRef.current[shortcutKey(event)];
      if (action && action(event) !== false) event.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}
