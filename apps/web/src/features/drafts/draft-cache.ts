import { queryOptions, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { Draft, DraftStatus, DraftSummary, Page } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { draftKeys, draftsApi } from './drafts-api';

export type DraftListData = InfiniteData<Page<DraftSummary>, string>;

/** 草稿详情：审阅弹窗与写信页（编辑服务端草稿）共用同一份 key 与请求 */
export const draftDetailQueryOptions = (id: number) => queryOptions({
  queryKey: draftKeys.detail(id),
  queryFn: ({ signal }) => draftsApi.get(id, signal),
});

/** 列表只放摘要：详情里的正文、附件等不进列表缓存 */
export function toDraftSummary(draft: DraftSummary | Draft): DraftSummary {
  const {
    replyTo: _replyTo, text: _text, html: _html, headers: _headers,
    replyToMessageId: _replyToMessageId, forwardAttachmentsFrom: _forward, attachments: _attachments,
    ...summary
  } = draft as Draft;
  return summary;
}

const filterOf = (queryKey: QueryKey) => queryKey[2] as DraftStatus | 'all';

/**
 * 写操作后就地更新各状态筛选下已加载的列表：仍属于该筛选的原位替换，不再属于的移出；
 * 还不在列表里的（新建、状态变化后进入该筛选）按 id 倒序插到已加载范围内，比已加载更旧且还有下一页时不插，翻页时自然出现。
 */
export function putDraftInLists(client: QueryClient, draft: DraftSummary | Draft): void {
  const summary = toDraftSummary(draft);
  for (const query of client.getQueryCache().findAll({ queryKey: draftKeys.lists })) {
    const listStatus = filterOf(query.queryKey);
    const belongs = listStatus === 'all' || listStatus === summary.status;
    client.setQueryData<DraftListData>(query.queryKey, (data) => {
      if (!data) return data;
      const present = data.pages.some((page) => page.items.some((item) => item.id === summary.id));
      if (present) {
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: belongs
              ? page.items.map((item) => (item.id === summary.id ? summary : item))
              : page.items.filter((item) => item.id !== summary.id),
          })),
        };
      }
      if (!belongs) return data;
      const pageIndex = data.pages.findIndex((page) => page.items.some((item) => item.id < summary.id));
      if (pageIndex < 0) {
        const last = data.pages[data.pages.length - 1];
        if (!last || last.nextCursor) return data;
        return { ...data, pages: [...data.pages.slice(0, -1), { ...last, items: [...last.items, summary] }] };
      }
      return {
        ...data,
        pages: data.pages.map((page, index) => {
          if (index !== pageIndex) return page;
          const at = page.items.findIndex((item) => item.id < summary.id);
          return { ...page, items: [...page.items.slice(0, at), summary, ...page.items.slice(at)] };
        }),
      };
    });
  }
}

export function removeDraftFromLists(client: QueryClient, id: number): void {
  for (const query of client.getQueryCache().findAll({ queryKey: draftKeys.lists })) {
    client.setQueryData<DraftListData>(query.queryKey, (data) => data && {
      ...data,
      pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== id) })),
    });
  }
  client.removeQueries({ queryKey: draftKeys.detail(id) });
}

/** 草稿已发出（草稿箱与写信页共用）：列表里标为已发送并带上邮件 id，详情下次重新获取 */
export function markDraftSent(client: QueryClient, draft: DraftSummary | Draft, messageId: number): void {
  putDraftInLists(client, { ...toDraftSummary(draft), status: 'sent', messageId, errorDetail: '', sentAt: new Date().toISOString() });
  void client.invalidateQueries({ queryKey: draftKeys.detail(draft.id) });
}

/** 保存（创建或修改）后的完整草稿：详情与各列表一起更新 */
export function storeDraft(client: QueryClient, draft: Draft): void {
  client.setQueryData(draftKeys.detail(draft.id), draft);
  putDraftInLists(client, draft);
}

/**
 * 发送失败或冲突后读回草稿的当前状态（failed、errorDetail、新版本等）并更新缓存；
 * 已被删除时移出列表，读取失败时让列表与详情下次重新获取。
 */
export async function refreshDraft(client: QueryClient, id: number): Promise<Draft | null> {
  try {
    const draft = await draftsApi.get(id);
    storeDraft(client, draft);
    return draft;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') removeDraftFromLists(client, id);
    else void client.invalidateQueries({ queryKey: draftKeys.root });
    return null;
  }
}
