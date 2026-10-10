import type { ListMessagesQuery } from '@hpc-mail/shared';

export interface InboxFilters {
  domain: string | null;
  address: string | null;
  unread: boolean;
  q: string;
}

/** URL 查询串 → 收件箱过滤器（URL 是唯一 source of truth） */
export function parseInboxFilters(params: URLSearchParams): InboxFilters {
  return {
    domain: params.get('domain') || null,
    address: params.get('address') || null,
    unread: params.get('unread') === '1',
    q: params.get('q') ?? '',
  };
}

/** 收件箱列表请求参数。InboxPage 与启动预取共用，二者必须得到同一个 queryKey。 */
export function inboxListQuery(filters: InboxFilters): Partial<ListMessagesQuery> {
  return {
    direction: 'inbound',
    scope: 'mine',
    domain: filters.domain ?? undefined,
    address: filters.address ?? undefined,
    unread: filters.unread || undefined,
    q: filters.q || undefined,
  };
}
