import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';

const mocks = vi.hoisted(() => ({ logout: vi.fn(async () => undefined) }));
vi.mock('@/api/resources', () => ({
  configApi: { getPublic: vi.fn(async () => ({ siteTitle: 'HPC Mail', registrationMode: 'closed', require2fa: false })) },
  messageApi: { unreadCount: vi.fn(async () => ({ unread: 0 })) },
  authApi: { logout: mocks.logout },
}));
import { draftKeyForUser } from '@/features/compose/compose-draft';
import { DRAFT_MAX_AGE_MS } from '@/features/compose/draft-retention';
import { sendAttemptKeyForUser } from '@/features/compose/send-attempt';
import { clearAuthToken, setAuthToken } from '@/lib/auth-token';
import { AppShell } from './app-shell';

const user: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

function renderShell() {
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
        children: [{ path: 'inbox', element: <p>收件列表</p> }],
      },
      { path: '/login', element: <p>登录页</p> },
    ],
    { initialEntries: ['/inbox'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

async function clickLogout() {
  const actor = userEvent.setup();
  await actor.click(screen.getByRole('button', { name: /alice/ }));
  await actor.click(await screen.findByRole('menuitem', { name: '退出登录' }));
  return actor;
}

const draft = (savedAt: number) => JSON.stringify({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Re: 报价', body: '> 原文', isHtml: false, savedAt });

beforeEach(() => {
  localStorage.clear();
  mocks.logout.mockClear();
  setAuthToken('jwt-of-alice');
});

describe('退出登录清理本机数据', () => {
  it('有未发送草稿时先确认；取消则什么都不清，确认后删除该账户的草稿、发送凭据与信任的发件人', async () => {
    localStorage.setItem(draftKeyForUser(1, 'reply:9'), draft(Date.now()));
    localStorage.setItem(sendAttemptKeyForUser(1), '{"key":"k"}');
    localStorage.setItem('hpc-trusted-image-senders:1', '["friend@example.com"]');
    localStorage.setItem(draftKeyForUser(2), draft(Date.now()));
    const { client, router } = renderShell();

    const actor = await clickLogout();
    const dialog = await screen.findByRole('dialog', { name: '退出并删除本机草稿？' });
    expect(dialog).toHaveTextContent('1 封未发送的草稿');
    await actor.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(localStorage.getItem('token')).toBe('jwt-of-alice');
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:9'))).not.toBeNull();

    await clickLogout();
    await actor.click(await screen.findByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:9'))).toBeNull();
    expect(localStorage.getItem(sendAttemptKeyForUser(1))).toBeNull();
    expect(localStorage.getItem('hpc-trusted-image-senders:1')).toBeNull();
    // 其他账户的草稿不动
    expect(localStorage.getItem(draftKeyForUser(2))).not.toBeNull();
    client.clear();
  });

  it('没有草稿时直接退出并清理', async () => {
    localStorage.setItem('hpc-trusted-image-senders:1', '["friend@example.com"]');
    const { client, router } = renderShell();
    await clickLogout();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('hpc-trusted-image-senders:1')).toBeNull();
    client.clear();
  });

  it('会话过期（只清 token）保留草稿，重新登录后可继续编辑', () => {
    localStorage.setItem(draftKeyForUser(1), draft(Date.now()));
    clearAuthToken();
    expect(localStorage.getItem(draftKeyForUser(1))).not.toBeNull();
  });

  it('打开外壳时回收最后保存超过 30 天的草稿', async () => {
    localStorage.setItem(draftKeyForUser(1, 'reply:1'), draft(Date.now() - DRAFT_MAX_AGE_MS - 60_000));
    localStorage.setItem(draftKeyForUser(1), draft(Date.now()));
    const { client } = renderShell();
    await screen.findByText('收件列表');
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:1'))).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(1))).not.toBeNull();
    client.clear();
  });
});
