import { hashKey, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageSummary } from '@hpc-mail/shared';

const api = vi.hoisted(() => ({
  config: vi.fn(async () => ({ siteTitle: 'HPC Mail', registrationMode: 'closed', domains: [] })),
  me: vi.fn(async () => ({ id: 1, username: 'me', role: 'user' })),
  mailboxes: vi.fn(async () => [{ id: 1, address: 'me@example.com', domain: 'example.com', displayName: '' }]),
  shared: vi.fn(async () => []),
  domains: vi.fn(async () => ['example.com']),
  list: vi.fn(async () => ({ items: [] as MessageSummary[], nextCursor: null })),
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
vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 84 })),
    getTotalSize: () => count * 84,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));
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
import { getAuthRevision } from '@/lib/auth-token';
import { useSessionQuery } from '@/lib/use-session';
import { bootPrefetch } from './boot-prefetch';
import { defaultInboxListKey, queryCacheStorageKey, writeQueryCache } from './query-persistence';

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

describe('持久缓存恢复', () => {
  const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 1, sid: 's' })}.sig`;
  const cachedMail = {
    id: 7, direction: 'inbound', address: 'me@example.com', domain: 'example.com', fromAddress: 'a@example.com', fromName: '',
    subject: '上次看到的邮件', preview: 'hi', verificationCode: '', status: 'received', errorDetail: '', isRead: false,
    isStarred: false, hasAttachments: false, size: 1, createdAt: '2026-10-10T00:00:00Z',
  } as MessageSummary;

  function SessionProbe() {
    const { data } = useSessionQuery();
    return <p>user={data?.username}</p>;
  }
  const renderInbox = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/inbox']}>
          <SessionProbe />
          <InboxPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('收件箱与会话用页面同一批 queryKey 恢复：首屏直接渲染缓存，后台各刷新一次', async () => {
    // 上次打开：页面经由启动预取正常取数，随后写入持久缓存
    localStorage.setItem('token', token);
    api.list.mockResolvedValueOnce({ items: [cachedMail], nextCursor: null });
    bootPrefetch(queryClient, { pathname: '/inbox', search: '' });
    const first = renderInbox();
    expect(await screen.findByText('上次看到的邮件')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('user=me')).toBeInTheDocument());
    writeQueryCache(queryClient);
    expect(localStorage.getItem(queryCacheStorageKey(1))).not.toContain('上次看到的邮件');
    first.unmount();
    queryClient.clear();
    Object.values(api).forEach((mock) => mock.mockClear());

    // 再次打开：接口都还没返回时首屏已恢复不含正文敏感字段的列表元数据
    const pending = () => new Promise<never>(() => {});
    for (const mock of [api.me, api.list, api.mailboxes, api.shared, api.domains, api.unread, api.config]) {
      (mock as ReturnType<typeof vi.fn>).mockImplementationOnce(pending);
    }
    bootPrefetch(queryClient, { pathname: '/inbox', search: '' });
    expect(cachedHashes()).toContain(hashKey(defaultInboxListKey()));
    expect(cachedHashes()).toContain(hashKey(queryKeys.sessionForRevision(getAuthRevision())));
    renderInbox();
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.queryByText('上次看到的邮件')).not.toBeInTheDocument();
    expect(screen.getByText('user=me')).toBeInTheDocument();
    expect(screen.getByText('同步中')).toBeInTheDocument();
    // 恢复的数据已过期：启动预取即后台刷新，挂载后不重复请求
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.me).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.mailboxes).toHaveBeenCalledTimes(1);
    expect(api.unread).toHaveBeenCalledTimes(1);
    expect(api.config).toHaveBeenCalledTimes(1);
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
