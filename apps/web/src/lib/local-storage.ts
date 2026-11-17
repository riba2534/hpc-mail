/** localStorage；隐私模式或被禁用时访问会抛错，这里返回 null */
export function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 本机 localStorage 里满足条件的全部 key：先收集再返回，调用方可以边遍历边删除；存储不可用时为空 */
export function storageKeys(match: (key: string) => boolean): string[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && match(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}
