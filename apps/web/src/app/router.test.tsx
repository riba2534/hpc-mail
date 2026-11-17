import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  config: vi.fn(async () => ({ siteTitle: 'HPC Mail', registrationMode: 'closed', require2fa: false, hostedDomainsEnabled: false })),
  unread: vi.fn(async () => ({ unread: 0 })),
}));
vi.mock('@/api/resources', () => ({
  authApi: { me: vi.fn(() => new Promise(() => {})), logout: vi.fn() },
  configApi: { getPublic: api.config },
  messageApi: { unreadCount: api.unread },
}));

const pages = vi.hoisted(() => ({ inboxFails: true }));
vi.mock('./route-modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./route-modules')>();
  function InboxPage() {
    if (pages.inboxFails) throw new Error('列表渲染异常');
    return <p>收件列表</p>;
  }
  return {
    ...actual,
    loadInboxPage: actual.preloadable(async () => ({ InboxPage })),
    loadSentPage: actual.preloadable(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://x/assets/sent-page.js')),
    ),
  };
});

import { queryKeys } from '@/api/query-keys';
import { getAuthRevision, setAuthToken } from '@/lib/auth-token';
import { routes } from './router';

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const user = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

function renderApp(path: string) {
  setAuthToken(`${b64url({ alg: 'HS256' })}.${b64url({ sub: 1 })}.sig`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.sessionForRevision(getAuthRevision()), user);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  pages.inboxFails = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('外壳内页面的错误边界', () => {
  it('页面渲染异常只替换主内容区，侧边栏与导航保留；重试后恢复', async () => {
    const { client } = renderApp('/inbox');
    expect(await screen.findByRole('heading', { name: '页面出错了' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('列表渲染异常');
    expect(screen.getByRole('navigation', { name: '主导航', hidden: true })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /星标/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '刷新页面' })).toBeNull();
    expect(screen.getByRole('link', { name: '返回收件箱' })).toHaveAttribute('href', '/inbox');

    pages.inboxFails = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('收件列表')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '页面出错了' })).toBeNull();
    client.clear();
  });

  it('页面 chunk 加载失败（已自动刷新过）也只替换主内容区', async () => {
    // 刚自动刷新过：冷却期内不再刷新，错误交给页面错误边界
    sessionStorage.setItem('hpc-mail:chunk-reload-at', String(Date.now()));
    const { client, router } = renderApp('/sent');
    expect(await screen.findByRole('heading', { name: '页面资源加载失败' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /星标/ }).length).toBeGreaterThan(0);
    // 导航到其他页面照常可用
    pages.inboxFails = false;
    fireEvent.click(screen.getByRole('link', { name: '返回收件箱' }));
    expect(await screen.findByText('收件列表')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/inbox');
    client.clear();
  });
});
