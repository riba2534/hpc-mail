import { queryOptions, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { configApi, domainApi } from '@/api/resources';

/** 公开站点配置：注册模式 / 公开域名 / 站点标题。长期缓存；启动时即预取。 */
export const publicConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.config,
    queryFn: () => configApi.getPublic(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

export function usePublicConfig() {
  return useQuery(publicConfigQueryOptions());
}

/**
 * 当前用户可见的域名（需登录，按角色返回）：管理员=全部系统域名，普通用户=公开子集。
 * 认领 / 收件箱筛选 / 写邮件选发件域的选项来源。
 */
export const domainsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.domains,
    queryFn: () => domainApi.visible(),
    staleTime: 60_000,
  });

export function useDomains() {
  return useQuery(domainsQueryOptions());
}
