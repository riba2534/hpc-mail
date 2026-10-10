import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@hpc-mail/shared';

const SETTINGS = {
  domains: { revision: 3, list: [] },
  register_mode: 'invite',
  code_extract: { enabled: true, aiEnabled: true },
  site: { title: 'HPC Mail' },
  api: { enabled: true },
  security: { require2fa: false },
  retention: { unclaimedDays: 90, allMessagesDays: 0 },
  quota: { dailyOutbound: 0, dailyRecipients: 0 },
  mailbox_policy: { perUserLimit: 5, reservedLocalParts: ['admin', 'root'] },
} as unknown as Settings;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.get, updateSettings: mocks.update } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));

import { parseReservedLocalParts, SettingsPage } from './settings-page';

function mount() {
  mocks.get.mockResolvedValue(structuredClone(SETTINGS));
  mocks.update.mockImplementation(async (patch: Partial<Settings>) => ({ ...structuredClone(SETTINGS), ...patch }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/admin/settings', element: <SettingsPage /> },
      { path: '/admin/users', element: <p>用户页</p> },
    ],
    { initialEntries: ['/admin/settings'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('parseReservedLocalParts', () => {
  it('支持逗号（含全角）、空白、换行分隔，转小写并去重', () => {
    expect(parseReservedLocalParts('Admin, root，ops\nhelp  admin、')).toEqual(['admin', 'root', 'ops', 'help']);
    expect(parseReservedLocalParts(' , \n')).toEqual([]);
  });
});

describe('SettingsPage 保留前缀', () => {
  it('输入逗号不会被吞掉，保存时提交解析后的数组', async () => {
    const { client } = mount();
    const textarea = await screen.findByDisplayValue('admin, root');

    fireEvent.change(textarea, { target: { value: 'admin, root, ' } });
    expect(textarea).toHaveValue('admin, root, ');
    // 只多了分隔符，解析结果不变，不算改动
    expect(screen.queryByText('有未保存的更改')).toBeNull();

    fireEvent.change(textarea, { target: { value: 'admin, root, Billing\nops' } });
    expect(textarea).toHaveValue('admin, root, Billing\nops');
    expect(screen.getByText('共 4 个')).toBeInTheDocument();

    fireEvent.blur(textarea);
    expect(textarea).toHaveValue('admin, root, billing, ops');

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          mailbox_policy: { perUserLimit: 5, reservedLocalParts: ['admin', 'root', 'billing', 'ops'] },
        }),
      ),
    );
    expect(mocks.update.mock.calls[0]![0]).not.toHaveProperty('domains');
    client.clear();
  });

  it('有未保存改动时站内跳转先确认，选择留下则不离开', async () => {
    const { client, router } = mount();
    const textarea = await screen.findByDisplayValue('admin, root');
    fireEvent.change(textarea, { target: { value: 'admin' } });

    void router.navigate('/admin/users');
    expect(await screen.findByText('离开此页？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '留在此页' }));
    await waitFor(() => expect(screen.queryByText('离开此页？')).toBeNull());
    expect(router.state.location.pathname).toBe('/admin/settings');

    void router.navigate('/admin/users');
    fireEvent.click(await screen.findByRole('button', { name: '放弃改动并离开' }));
    expect(await screen.findByText('用户页')).toBeInTheDocument();
    client.clear();
  });
});
