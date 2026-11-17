import { QueryClient } from '@tanstack/react-query';
import type { DraftSummary } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { type DraftListData, putDraftInLists, removeDraftFromLists } from './draft-cache';
import { draftKeys } from './drafts-api';

const item = (id: number, status: DraftSummary['status'] = 'draft') => ({ id, status, subject: `#${id}` }) as DraftSummary;
const list = (pages: Array<{ ids: Array<[number, DraftSummary['status']]>; next: string | null }>): DraftListData => ({
  pages: pages.map((page) => ({ items: page.ids.map(([id, status]) => item(id, status)), nextCursor: page.next })),
  pageParams: pages.map((_, index) => (index ? `c${index}` : '')),
});
const ids = (client: QueryClient, status: Parameters<typeof draftKeys.list>[0]) =>
  client.getQueryData<DraftListData>(draftKeys.list(status))?.pages.map((page) => page.items.map((entry) => `${entry.id}:${entry.status}`));

describe('草稿列表缓存', () => {
  it('状态变化：全部列表原位替换，原筛选移出，新筛选按 id 倒序插入', () => {
    const client = new QueryClient();
    client.setQueryData(draftKeys.list('all'), list([{ ids: [[9, 'draft'], [5, 'scheduled'], [3, 'draft']], next: null }]));
    client.setQueryData(draftKeys.list('scheduled'), list([{ ids: [[5, 'scheduled']], next: null }]));
    client.setQueryData(draftKeys.list('sent'), list([{ ids: [[8, 'sent'], [2, 'sent']], next: null }]));
    putDraftInLists(client, item(5, 'sent'));
    expect(ids(client, 'all')).toEqual([['9:draft', '5:sent', '3:draft']]);
    expect(ids(client, 'scheduled')).toEqual([[]]);
    expect(ids(client, 'sent')).toEqual([['8:sent', '5:sent', '2:sent']]);
  });

  it('新建的放到最前；比已加载的都旧且还有下一页时不插（翻页时自然出现）', () => {
    const client = new QueryClient();
    client.setQueryData(draftKeys.list('all'), list([{ ids: [[9, 'draft']], next: 'c1' }]));
    putDraftInLists(client, item(12));
    putDraftInLists(client, item(4));
    expect(ids(client, 'all')).toEqual([['12:draft', '9:draft']]);
  });

  it('删除后各列表都移除', () => {
    const client = new QueryClient();
    client.setQueryData(draftKeys.list('all'), list([{ ids: [[9, 'draft'], [5, 'draft']], next: null }]));
    client.setQueryData(draftKeys.list('draft'), list([{ ids: [[9, 'draft'], [5, 'draft']], next: null }]));
    removeDraftFromLists(client, 9);
    expect(ids(client, 'all')).toEqual([['5:draft']]);
    expect(ids(client, 'draft')).toEqual([['5:draft']]);
  });
});
