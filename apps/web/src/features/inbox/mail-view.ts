import type { ListMessagesQuery } from '@hpc-mail/shared';

/** 列表/详情共用的管理员可见性上下文，拼进 /mail/:id 与 API query */
export function mailViewParams(query: Partial<ListMessagesQuery>): URLSearchParams {
  const params = new URLSearchParams();
  if (query.scope === 'unclaimed' || query.scope === 'user') params.set('scope', query.scope);
  if (query.scope === 'user' && query.userId) params.set('userId', String(query.userId));
  return params;
}

export function mailHref(id: number, query: Partial<ListMessagesQuery>): string {
  const qs = mailViewParams(query).toString();
  return qs ? `/mail/${id}?${qs}` : `/mail/${id}`;
}
