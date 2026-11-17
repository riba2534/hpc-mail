import type {
  AdminHostedDomainsQuery,
  CreateHostedDomainRequest,
  HostedDnsRecord,
  HostedDnsRecordInput,
  HostedDomain,
  HostedDomainMember,
  HostedDomainsHealth,
  HostedDomainTransferResult,
  Page,
  ReplaceHostedDomainMembersRequest,
  TransferHostedDomainRequest,
  UpdateHostedDomainRequest,
} from '@hpc-mail/shared';
import { api } from '@/api/client';

/** 检测会同步调用 Cloudflare 接口推进开通，给足时间 */
const CHECK_TIMEOUT_MS = 60_000;

/** 托管域名接口只在这几个懒加载页面用到，不放进入口 chunk 里的 api/resources.ts */
export const hostedDomainApi = {
  list: () => api.get<HostedDomain[]>('/hosted-domains'),
  create: (body: CreateHostedDomainRequest) =>
    api.post<HostedDomain, CreateHostedDomainRequest>('/hosted-domains', body, { timeoutMs: CHECK_TIMEOUT_MS }),
  get: (id: number) => api.get<HostedDomain>(`/hosted-domains/${id}`),
  /** 立即向 Cloudflare 检测并推进开通 */
  check: (id: number) => api.post<HostedDomain>(`/hosted-domains/${id}/check`, undefined, { timeoutMs: CHECK_TIMEOUT_MS }),
  update: (id: number, body: UpdateHostedDomainRequest) =>
    api.put<HostedDomain, UpdateHostedDomainRequest>(`/hosted-domains/${id}`, body),
  remove: (id: number) => api.delete<{ success: boolean }>(`/hosted-domains/${id}`),
  members: (id: number) => api.get<HostedDomainMember[]>(`/hosted-domains/${id}/members`),
  replaceMembers: (id: number, body: ReplaceHostedDomainMembersRequest) =>
    api.put<HostedDomainMember[], ReplaceHostedDomainMembersRequest>(`/hosted-domains/${id}/members`, body),
  /** 所有者/管理员移除成员；成员传自己的 userId 即退出共享 */
  removeMember: (id: number, userId: number) =>
    api.delete<{ success: boolean }>(`/hosted-domains/${id}/members/${userId}`),
  transfer: (id: number, body: TransferHostedDomainRequest) =>
    api.post<HostedDomainTransferResult, TransferHostedDomainRequest>(`/hosted-domains/${id}/transfer`, body),
  /** DNS 解析：读写都直连 Cloudflare，写操作给足时间 */
  dnsRecords: (id: number) => api.get<HostedDnsRecord[]>(`/hosted-domains/${id}/dns-records`),
  createDnsRecord: (id: number, body: HostedDnsRecordInput) =>
    api.post<HostedDnsRecord, HostedDnsRecordInput>(`/hosted-domains/${id}/dns-records`, body, { timeoutMs: CHECK_TIMEOUT_MS }),
  updateDnsRecord: (id: number, recordId: string, body: HostedDnsRecordInput) =>
    api.put<HostedDnsRecord, HostedDnsRecordInput>(`/hosted-domains/${id}/dns-records/${recordId}`, body, {
      timeoutMs: CHECK_TIMEOUT_MS,
    }),
  deleteDnsRecord: (id: number, recordId: string) =>
    api.delete<{ success: boolean }>(`/hosted-domains/${id}/dns-records/${recordId}`),
};

export type AdminHostedDomainFilters = Pick<AdminHostedDomainsQuery, 'status' | 'q'>;

export const adminHostedDomainApi = {
  /** 带 limit 即返回 Page（按 id 倒序）；cursor 为空表示首页 */
  list: (filters: AdminHostedDomainFilters, cursor: string, limit: number) =>
    api.get<Page<HostedDomain>>('/admin/hosted-domains', { query: { status: filters.status, q: filters.q, cursor, limit } }),
  suspend: (id: number) => api.post<HostedDomain>(`/admin/hosted-domains/${id}/suspend`),
  resume: (id: number) => api.post<HostedDomain>(`/admin/hosted-domains/${id}/resume`),
  health: () => api.get<HostedDomainsHealth>('/admin/hosted-domains/health'),
};
