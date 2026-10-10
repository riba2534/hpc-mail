import type { ListMessagesQuery, MessageListScope } from '@hpc-mail/shared';

/** 详情/线程/星标请求携带的可见性上下文（缺省 = 个人邮箱） */
export type MailView = { scope: MessageListScope; userId?: number };

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

/** /mail/:id 的查询串 → 详情可见性上下文。详情页、行悬停预取和启动预取都经由它，保证 queryKey 一致。 */
export function parseMailView(params: URLSearchParams): MailView | undefined {
  const scopeRaw = params.get('scope');
  const scope = scopeRaw === 'unclaimed' || scopeRaw === 'user' || scopeRaw === 'mine' ? scopeRaw : undefined;
  const userIdRaw = Number(params.get('userId'));
  const userId = Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : undefined;
  return scope ? { scope, userId } : undefined;
}

/** 列表行链接到的详情所使用的可见性上下文 */
export function listMailView(query: Partial<ListMessagesQuery>): MailView | undefined {
  return parseMailView(mailViewParams(query));
}
