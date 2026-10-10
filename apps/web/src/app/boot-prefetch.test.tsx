import { hashKey, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery } from '@hpc-mail/shared';

const api = vi.hoisted(() => ({
  config: vi.fn(async () => ({ siteTitle: 'HPC Mail', registrationMode: 'closed', domains: [] })),
  me: vi.fn(async () => ({ id: 1, username: 'me', role: 'user' })),
  mailboxes: vi.fn(async () => [{ id: 1, address: 'me@example.com', domain: 'example.com', displayName: '' }]),
  shared: vi.fn(async () => []),
  domains: vi.fn(async () => ['example.com']),
  list: vi.fn(async () => ({ items: [], nextCursor: null })),
  detail: vi.fn(async (id: number) => ({ id })),
  unread: vi.fn(async () => ({ unread: 0 })),
}));
vi.mock('@/api/resources', () => ({
  authApi: { me: api.me },
  configApi: { getPublic: api.config },
  domainApi: { visible: api.domains },
  mailboxApi: { list: api.mailboxes, shared: api.shared },
  messageApi: { list: api.list, detail: api.detail, unreadCount: api.unread },
}));
const loaders = vi.hoisted(() => ({ shell: vi.fn(async () => ({})), route: vi.fn(async () => ({})) }));
vi.mock('./route-modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./route-modules')>();
  return {
    ...actual,
    loadAppShell: loaders.shell,
    routeLoaderFor: (pathname: string) => (actual.routeLoaderFor(pathname) ? loaders.route : undefined),
  };
});

import { queryKeys } from '@/api/query-keys';
import { InboxPage } from '@/features/inbox/inbox-page';
import { listMailView, mailHref, parseMailView } from '@/features/inbox/mail-view';
import { queryClient } from '@/lib/query-client';
import { bootPrefetch } from './boot-prefetch';

const cachedHashes = () => queryClient.getQueryCache().getAll().map((query) => query.queryHash);

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((mock) => mock.mockClear());
  Object.values(loaders).forEach((mock) => mock.mockClear());
});
afterEach(() => queryClient.clear());

describe('bootPrefetch', () => {
  it('未登录只预取公开配置', () => {
    bootPrefetch(queryClient, { pathname: '/login', search: '' });
    expect(api.config).toHaveBeenCalledTimes(1);
    expect(api.me).not.toHaveBeenCalled();
    expect(loaders.shell).not.toHaveBeenCalled();
    expect(cachedHashes()).toEqual([hashKey(queryKeys.config)]);
  });

  it('收件箱首屏与 InboxPage 使用同一批 queryKey，挂载后不再重复请求', async () => {
    localStorage.setItem('token', 'token-1');
    bootPrefetch(queryClient, { pathname: '/inbox', search: '?unread=1&q=code' });
    expect(loaders.shell).toHaveBeenCalledTimes(1);
    expect(loaders.route).toHaveBeenCalledTimes(1);
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith(
      { direction: 'inbound', scope: 'mine', unread: true, q: 'code', domain: undefined, address: undefined, cursor: undefined },
      expect.any(AbortSignal),
    );
    // 与页面原先手写的请求参数逐字段一致（undefined 字段不参与哈希）
    const expected: Partial<ListMessagesQuery> = { direction: 'inbound', scope: 'mine', unread: true, q: 'code' };
    expect(cachedHashes()).toContain(hashKey(queryKeys.messages.list(expected)));

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/inbox?unread=1&q=code']}>
          <InboxPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.unread).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.mailboxes).toHaveBeenCalledTimes(1);
    expect(api.shared).toHaveBeenCalledTimes(1);
    expect(api.domains).toHaveBeenCalledTimes(1);
  });

  it('根路径重定向到不带筛选的收件箱', () => {
    localStorage.setItem('token', 'token-1');
    bootPrefetch(queryClient, { pathname: '/', search: '?unread=1' });
    expect(cachedHashes()).toContain(hashKey(queryKeys.messages.list({ direction: 'inbound', scope: 'mine' })));
  });

  it('邮件直链预取详情，key 与详情页解析的可见性上下文一致', () => {
    localStorage.setItem('token', 'token-1');
    bootPrefetch(queryClient, { pathname: '/mail/42', search: '?scope=user&userId=7' });
    expect(api.detail).toHaveBeenCalledWith(42, { scope: 'user', userId: 7 }, expect.any(AbortSignal));
    expect(cachedHashes()).toContain(hashKey(queryKeys.messages.detail(42, { scope: 'user', userId: 7 })));
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe('列表行预取与详情页的 key 一致', () => {
  it.each<Partial<ListMessagesQuery>>([
    { direction: 'inbound', scope: 'mine' },
    { scope: 'mine', starred: true },
    { scope: 'unclaimed' },
    { scope: 'user', userId: 9 },
  ])('%o', (query) => {
    const fromLink = parseMailView(new URL(mailHref(5, query), 'https://hpc.test').searchParams);
    expect(hashKey(queryKeys.messages.detail(5, listMailView(query)))).toBe(hashKey(queryKeys.messages.detail(5, fromLink)));
  });
});
