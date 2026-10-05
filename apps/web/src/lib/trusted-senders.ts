function read(userId: number): string[] {
  try {
    const raw = localStorage.getItem(`hpc-trusted-image-senders:${userId}`);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 该发件人是否已被信任（自动显示远程图片） */
export function isTrustedSender(address: string, userId: number): boolean {
  return read(userId).includes(address.toLowerCase());
}

/** 记住信任该发件人，之后自动显示其远程图片 */
export function trustSender(address: string, userId: number): void {
  const addr = address.toLowerCase();
  const list = read(userId);
  if (list.includes(addr)) return;
  try {
    localStorage.setItem(`hpc-trusted-image-senders:${userId}`, JSON.stringify([...list, addr].slice(-500)));
  } catch {
    // 存储不可用时静默
  }
}
