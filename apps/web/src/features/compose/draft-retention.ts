/**
 * 草稿在本机的留存：按账户列出草稿、启动时回收遗弃的草稿。
 * 不引入 @hpc-mail/shared，外壳 chunk 可以静态引用而不带上契约包。
 */

/** 写信草稿 key 的公共前缀：`hpc-compose-draft:<uid>`（旧版单 key）与 `hpc-compose-draft:<uid>:<场景>` */
export const DRAFT_KEY_PREFIX = 'hpc-compose-draft:';
/** 最后保存超过 30 天的草稿视为遗弃 */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function draftKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/** 该账户在本机保存的未发送草稿（新建与各封邮件的回复/转发/重发） */
export function userDraftKeys(userId: number): string[] {
  const own = `${DRAFT_KEY_PREFIX}${userId}`;
  return draftKeys().filter((key) => key === own || key.startsWith(`${own}:`));
}

/**
 * 回收所有账户遗弃的草稿：最后保存超过 30 天、或内容已损坏无法恢复的删除；
 * 没有 savedAt 的旧版草稿从现在起计时（补写 savedAt）。返回删除的条数。
 */
export function purgeExpiredDrafts(now = Date.now()): number {
  let removed = 0;
  for (const key of draftKeys()) {
    try {
      const raw = localStorage.getItem(key);
      let draft: unknown = null;
      try {
        draft = JSON.parse(raw ?? 'null');
      } catch {
        draft = null;
      }
      if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
        localStorage.removeItem(key);
        removed += 1;
        continue;
      }
      const { savedAt } = draft as { savedAt?: unknown };
      if (savedAt === undefined) {
        localStorage.setItem(key, JSON.stringify({ ...draft, savedAt: now }));
      } else if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || now - savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(key);
        removed += 1;
      }
    } catch {
      // 存储不可用：下次启动再试
    }
  }
  return removed;
}
