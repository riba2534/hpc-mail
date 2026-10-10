import { useCallback, useSyncExternalStore } from 'react';

/** 订阅 CSS 媒体查询；环境不支持 matchMedia（如测试 jsdom）时恒为 false */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof globalThis.matchMedia !== 'function') return () => {};
      const list = globalThis.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = () => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** 小于 Tailwind sm（640px）的窄屏：表格改为卡片列表 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 639.98px)');
}
