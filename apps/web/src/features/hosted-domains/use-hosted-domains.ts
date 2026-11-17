import { type InfiniteData, type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import type { HostedDnsRecord, HostedDomain, HostedDomainStatus, Page } from '@hpc-mail/shared';
import { ApiError, isRejectedRequest } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { hostedDomainApi } from './hosted-domains-api';

/** 等待生效期间详情页自动刷新的间隔 */
export const HOSTED_DOMAIN_POLL_MS = 30_000;
const POLLING_STATUSES: readonly HostedDomainStatus[] = ['pending', 'provisioning'];

export const hostedDomainsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.hostedDomains.list,
    queryFn: () => hostedDomainApi.list(),
  });

export function useHostedDomainsQuery() {
  return useQuery(hostedDomainsQueryOptions());
}

/** 单个域名；等待 NS 或开通中时每 30 秒刷新一次，进入其他状态后停止 */
export function useHostedDomainQuery(id: number, enabled: boolean, placeholder?: () => HostedDomain | undefined) {
  return useQuery({
    queryKey: queryKeys.hostedDomains.detail(id),
    queryFn: () => hostedDomainApi.get(id),
    enabled,
    placeholderData: placeholder,
    refetchInterval: (query) =>
      query.state.data && POLLING_STATUSES.includes(query.state.data.status) ? HOSTED_DOMAIN_POLL_MS : false,
  });
}

const replaceIn = (list: HostedDomain[] | undefined, domain: HostedDomain) =>
  list?.map((item) => (item.id === domain.id ? domain : item));

/** 写操作返回的最新域名：就地更新详情与各列表缓存（管理员全站列表是分页缓存，逐页替换），不整体重拉 */
export function storeHostedDomain(client: QueryClient, domain: HostedDomain): void {
  client.setQueryData(queryKeys.hostedDomains.detail(domain.id), domain);
  client.setQueryData<HostedDomain[]>(queryKeys.hostedDomains.list, (list) => replaceIn(list, domain));
  client.setQueriesData<InfiniteData<Page<HostedDomain>>>({ queryKey: queryKeys.admin.hostedDomains },
    (data) => data && { ...data, pages: data.pages.map((page) => ({ ...page, items: replaceIn(page.items, domain)! })) });
}

/** 只改详情缓存里的几个计数（成员数等），列表随后台失效重拉 */
export function patchHostedDomain(client: QueryClient, id: number, patch: Partial<HostedDomain>): void {
  client.setQueryData<HostedDomain>(queryKeys.hostedDomains.detail(id), (domain) => domain && { ...domain, ...patch });
  void client.invalidateQueries({ queryKey: queryKeys.hostedDomains.list });
  void client.invalidateQueries({ queryKey: queryKeys.admin.hostedDomains });
}

/** 域名不再对当前用户可见（删除、退出共享、过户后失去权限）：移出缓存，可认领域名随之变化 */
export function forgetHostedDomain(client: QueryClient, id: number): void {
  client.removeQueries({ queryKey: queryKeys.hostedDomains.detail(id) });
  client.removeQueries({ queryKey: queryKeys.hostedDomains.members(id) });
  client.removeQueries({ queryKey: queryKeys.hostedDomains.dnsRecords(id) });
  client.setQueryData<HostedDomain[]>(queryKeys.hostedDomains.list, (list) => list?.filter((item) => item.id !== id));
  void client.invalidateQueries({ queryKey: queryKeys.hostedDomains.list });
  void client.invalidateQueries({ queryKey: queryKeys.admin.hostedDomains });
  void client.invalidateQueries({ queryKey: queryKeys.domains });
}

export function useHostedDnsRecordsQuery(id: number) {
  return useQuery({
    queryKey: queryKeys.hostedDomains.dnsRecords(id),
    queryFn: () => hostedDomainApi.dnsRecords(id),
    // 每次请求都计入解析限流并可能等待 Cloudflare 超时，失败后由用户手动重试
    retry: false,
  });
}

/**
 * 解析写操作失败后刷新：不是确定被拒绝的请求（网络中断、超时、5xx、边缘返回的非 JSON 页面）时 Cloudflare 可能已经写入，
 * 结果不确定；被拒绝时只有记录已不存在、冲突或权限变化说明列表过期。forbidden 多半是域名刚被暂停，连同域名详情一起刷新
 */
export function refreshAfterDnsWriteError(client: QueryClient, domainId: number, error: unknown): void {
  if (error instanceof ApiError && error.code === 'forbidden') {
    void client.invalidateQueries({ queryKey: queryKeys.hostedDomains.detail(domainId) });
  }
  if (!isRejectedRequest(error) || ['not_found', 'conflict', 'forbidden'].includes(error.code)) {
    void client.invalidateQueries({ queryKey: queryKeys.hostedDomains.dnsRecords(domainId) });
  }
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 与服务端一致：按名称（@ 最前）、类型、内容排序 */
function compareDnsRecords(a: HostedDnsRecord, b: HostedDnsRecord): number {
  return (
    Number(b.name === '@') - Number(a.name === '@') ||
    byCodePoint(a.name, b.name) ||
    byCodePoint(a.type, b.type) ||
    byCodePoint(a.content, b.content)
  );
}

/** 新增或修改成功：就地插入或替换并重新排序，不整体重拉 */
export function storeDnsRecord(client: QueryClient, domainId: number, record: HostedDnsRecord): void {
  client.setQueryData<HostedDnsRecord[]>(
    queryKeys.hostedDomains.dnsRecords(domainId),
    (list) => list && [...list.filter((item) => item.id !== record.id), record].sort(compareDnsRecords),
  );
}

export function removeDnsRecord(client: QueryClient, domainId: number, recordId: string): void {
  client.setQueryData<HostedDnsRecord[]>(
    queryKeys.hostedDomains.dnsRecords(domainId),
    (list) => list?.filter((item) => item.id !== recordId),
  );
}
