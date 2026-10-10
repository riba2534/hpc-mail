import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser, UserNotifyPrefs } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  testFeishu: vi.fn(async () => ({ ok: true })),
  testPushdeer: vi.fn(async () => ({ ok: true })),
  toast: vi.fn(),
  calls: [] as string[],
}));
vi.mock('@/api/resources', () => ({
  notifyPrefsApi: { get: mocks.get, update: mocks.update, testFeishu: mocks.testFeishu, testPushdeer: mocks.testPushdeer },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/compose/recipient-input', () => ({
  RecipientInput: ({ 'aria-label': label }: { 'aria-label': string }) => <div aria-label={label} />,
}));
import { ForwardingSection } from './forwarding-section';

const user: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

const prefs = (): UserNotifyPrefs => ({
  feishu: { enabled: true, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/old', secret: '', contentLevel: 'summary' },
  webhook: { enabled: false, url: '', secret: '' },
  forward: { enabled: false, addresses: [] },
  pushdeer: { enabled: false, endpoint: '', pushkey: '' },
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/profile',
        element: (
          <CurrentUserContext.Provider value={user}>
            <ForwardingSection />
          </CurrentUserContext.Provider>
        ),
      },
      { path: '/inbox', element: <p>收件箱页</p> },
    ],
    { initialEntries: ['/profile'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
});

describe('转发与通知', () => {
  it('通道开关打开才展开配置项', async () => {
    mocks.get.mockResolvedValue(prefs());
    const { client } = renderSection();
    await screen.findByText('飞书通知');
    expect(screen.getByPlaceholderText(/open\.feishu\.cn/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/接收 HPC 事件/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: '通用 Webhook' }));
    expect(screen.getByPlaceholderText(/接收 HPC 事件/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '飞书通知' }));
    expect(screen.queryByPlaceholderText(/open\.feishu\.cn/)).toBeNull();
    client.clear();
  });

  it('有未保存改动时发送测试会先自动保存，再用保存后的配置测试', async () => {
    mocks.get.mockResolvedValue(prefs());
    mocks.update.mockImplementation(async (body: UserNotifyPrefs) => {
      mocks.calls.push('save');
      return body;
    });
    mocks.testFeishu.mockImplementation(async () => {
      mocks.calls.push('test');
      return { ok: true };
    });
    const { client } = renderSection();
    const url = await screen.findByPlaceholderText(/open\.feishu\.cn/);
    fireEvent.change(url, { target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发送测试卡片' }));
    await waitFor(() => expect(mocks.calls).toEqual(['save', 'test']));
    expect(mocks.update.mock.calls[0]![0].feishu.webhookUrl).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/new');
    // 保存后没有改动，按钮文案回到普通测试
    expect(await screen.findByRole('button', { name: '发送测试卡片' })).toBeEnabled();
    client.clear();
  });

  it('自动保存失败时不发送测试', async () => {
    mocks.get.mockResolvedValue(prefs());
    mocks.update.mockRejectedValue(new Error('boom'));
    const { client } = renderSection();
    const url = await screen.findByPlaceholderText(/open\.feishu\.cn/);
    fireEvent.change(url, { target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发送测试卡片' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并发送测试卡片' })).toBeEnabled());
    expect(mocks.testFeishu).not.toHaveBeenCalled();
    client.clear();
  });

  it('无改动时直接测试，不触发保存', async () => {
    mocks.get.mockResolvedValue(prefs());
    const { client } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '发送测试卡片' }));
    await waitFor(() => expect(mocks.testFeishu).toHaveBeenCalledTimes(1));
    expect(mocks.update).not.toHaveBeenCalled();
    client.clear();
  });

  it('有未保存改动时站内跳转先确认', async () => {
    mocks.get.mockResolvedValue(prefs());
    const { client, router } = renderSection();
    const url = await screen.findByPlaceholderText(/open\.feishu\.cn/);
    fireEvent.change(url, { target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/new' } });
    await act(() => router.navigate('/inbox'));
    expect(await screen.findByRole('dialog', { name: '离开此页？' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
    fireEvent.click(screen.getByRole('button', { name: '留在此页' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/profile');
    await act(() => router.navigate('/inbox'));
    fireEvent.click(await screen.findByRole('button', { name: '放弃改动并离开' }));
    expect(await screen.findByText('收件箱页')).toBeInTheDocument();
    client.clear();
  });

  it('有未保存改动时刷新页面触发 beforeunload 拦截', async () => {
    mocks.get.mockResolvedValue(prefs());
    const { client } = renderSection();
    const url = await screen.findByPlaceholderText(/open\.feishu\.cn/);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(url, { target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/new' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    client.clear();
  });
});
