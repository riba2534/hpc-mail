import { queryOptions, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';

/** 自己认领的邮箱（管理员的全站分页见 features/admin/addresses/admin-mailboxes.ts） */
export const mailboxesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.mailboxes.list('mine'),
    queryFn: () => mailboxApi.list(),
  });

/** 分享给我的邮箱。只用于收件筛选，不进入发件身份。 */
export const sharedMailboxesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.mailboxes.shared,
    queryFn: () => mailboxApi.shared(),
  });

export function useMailboxesQuery() {
  return useQuery(mailboxesQueryOptions());
}

export function useSharedMailboxesQuery() {
  return useQuery(sharedMailboxesQueryOptions());
}
