import type { QueryClient } from '@tanstack/react-query';
import { authApi } from '@/api/resources';
import { clearAuthToken } from '@/lib/auth-token';
import { safeStorage, storageKeys } from '@/lib/local-storage';

/**
 * 本机按账户保存的数据：`hpc-<名称>:<uid>[:...]`（写信草稿、发送凭据、
 * 默认与上次使用的发件身份）以及首屏查询缓存 `hpc-query-cache:<版本>:<uid>`。
 */
const userKeyPattern = (userId: number) => new RegExp(`^hpc-[a-z-]+:(?:v\\d+:)?${userId}(?::|$)`);

/**
 * 主动退出登录时删除该账户在本机留下的全部数据，共用电脑的下一位打不开上一位的草稿与往来地址。
 * 会话过期（401）不经过这里，草稿保留到重新登录。
 */
export function clearUserLocalData(userId: number): void {
  const pattern = userKeyPattern(userId);
  for (const key of storageKeys((key) => pattern.test(key))) safeStorage()?.removeItem(key);
}

/**
 * 主动退出登录（外壳菜单与守卫错误页共用）：先通知服务端吊销会话（失败照常清理），再删除该账户在本机的数据、
 * 清 token 与查询缓存。userId 未知（守卫错误页没有用户数据、token 也读不出账户）时只清 token 与缓存。
 */
export async function signOut(queryClient: QueryClient, userId: number | undefined): Promise<void> {
  try {
    await authApi.logout();
  } catch {
    // 忽略：本地清理照常进行
  }
  if (userId !== undefined) clearUserLocalData(userId);
  clearAuthToken();
  queryClient.clear();
}
