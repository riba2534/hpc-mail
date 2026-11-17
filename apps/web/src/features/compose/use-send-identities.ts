import { queryOptions, useQuery } from '@tanstack/react-query';
import type { SendIdentities } from '@hpc-mail/shared';
import { api } from '@/api/client';

/**
 * 只有写信页读取，不进 boot 预取与持久化。key 挂在 mailboxes 下：认领、释放、过户与删除托管域名
 * 都会让 mailboxes 整体失效，发件身份随之刷新。
 */
export const sendIdentitiesQueryOptions = () =>
  queryOptions({
    queryKey: ['mailboxes', 'identities'] as const,
    queryFn: () => api.get<SendIdentities>('/identities'),
  });

const NONE: string[] = [];
const hostedOf = (data: SendIdentities) => data.domains.filter((item) => item.kind === 'hosted').map((item) => item.domain);

/**
 * 自己作为所有者、发信就绪的托管域名：可用任意前缀发信，发出时自动认领。
 * 读取中为 undefined；读取失败按没有处理，只是少了自定义前缀这一项，不挡已认领邮箱发信。
 */
export function useHostedSendDomains(): string[] | undefined {
  const { data, isError } = useQuery({ ...sendIdentitiesQueryOptions(), select: hostedOf });
  return isError ? NONE : data;
}
