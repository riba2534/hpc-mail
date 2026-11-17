/**
 * 本机按账户保存的数据：`hpc-<名称>:<uid>[:...]`（写信草稿、发送凭据、信任显示图片的发件人、
 * 默认与上次使用的发件身份）以及首屏查询缓存 `hpc-query-cache:<版本>:<uid>`。
 */
const userKeyPattern = (userId: number) => new RegExp(`^hpc-[a-z-]+:(?:v\\d+:)?${userId}(?::|$)`);

/**
 * 主动退出登录时删除该账户在本机留下的全部数据，共用电脑的下一位打不开上一位的草稿与往来地址。
 * 会话过期（401）不经过这里，草稿保留到重新登录。
 */
export function clearUserLocalData(userId: number): void {
  try {
    const pattern = userKeyPattern(userId);
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && pattern.test(key)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 存储不可用：本来也没有留下数据
  }
}
