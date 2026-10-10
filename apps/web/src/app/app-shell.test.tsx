import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';
import { useDocumentTitle } from '@/lib/use-document-title';
const mocks = vi.hoisted(() => ({
  config: vi.fn(async () => ({ siteTitle: 'HPC Mail', registrationMode: 'closed', require2fa: false })),
  unread: vi.fn(async () => ({ unread: 45 })),
}));
vi.mock('@/api/resources', () => ({
  configApi: { getPublic: mocks.config },
  messageApi: { unreadCount: mocks.unread },
  authApi: { logout: vi.fn() },
}));
import { AppShell, hidesBottomNav } from './app-shell';

const user: SessionUser = {
  id: 1,
  username: 'alice',
  role: 'user',
  createdAt: '2026-10-01T00:00:00Z',
  avatarUrl: null,
  twoFactorEnabled: false,
};

function MessagePage() {
  useDocumentTitle('你的登录验证码');
  return <p>邮件正文</p>;
}

function renderShell(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <CurrentUserContext.Provider value={user}>
            <AppShell />
          </CurrentUserContext.Provider>
        ),
        children: [
          { path: 'inbox', element: <p>收件列表</p>, handle: { title: '收件箱' } },
          { path: 'mail/:id', element: <MessagePage />, handle: { title: '邮件详情' } },
          { path: 'compose', element: <p>写信</p>, handle: { title: '写邮件' } },
          { path: 'profile', element: <p>设置</p>, handle: { title: '个人设置' } },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

afterEach(() => {
  document.title = '';
});

describe('hidesBottomNav', () => {
  it('详情与写信页隐藏底部导航', () => {
    expect(hidesBottomNav('/mail/12')).toBe(true);
    expect(hidesBottomNav('/compose')).toBe(true);
    expect(hidesBottomNav('/inbox')).toBe(false);
    expect(hidesBottomNav('/mailboxes')).toBe(false);
  });
});

describe('AppShell', () => {
  it('标签页标题带未读数，切页跟随路由标题，页面可覆盖', async () => {
    const { client, router } = renderShell('/inbox');
    await waitFor(() => expect(document.title).toBe('(45) 收件箱 · HPC Mail'));
    await act(() => router.navigate('/profile'));
    expect(document.title).toBe('(45) 个人设置 · HPC Mail');
    await act(() => router.navigate('/mail/7'));
    expect(document.title).toBe('(45) 你的登录验证码 · HPC Mail');
    client.clear();
  });

  it('跳到主内容链接把焦点移到 main，底部导航带安全区并在详情页隐藏', async () => {
    const { client, router } = renderShell('/inbox');
    fireEvent.click(screen.getByRole('link', { name: '跳到主内容' }));
    expect(screen.getByRole('main')).toHaveFocus();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(nav.className).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(nav).not.toHaveClass('hidden');
    expect(nav).toHaveAttribute('data-bottom-nav', '');
    await act(() => router.navigate('/mail/7'));
    const hiddenNav = screen.getByRole('navigation', { name: '主导航', hidden: true });
    expect(hiddenNav).toHaveClass('hidden');
    expect(hiddenNav).not.toHaveAttribute('data-bottom-nav');
    client.clear();
  });

  it('? 打开快捷键帮助', async () => {
    const { client } = renderShell('/inbox');
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    expect(await screen.findByRole('dialog', { name: '键盘快捷键' })).toBeInTheDocument();
    client.clear();
  });
});
