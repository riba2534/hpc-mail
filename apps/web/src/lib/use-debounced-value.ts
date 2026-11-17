import { useEffect, useState } from 'react';

/** 搜索框防抖：value 停止变化 ms 毫秒后才返回新值，初始值立即可用 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(value), ms);
    return () => globalThis.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
