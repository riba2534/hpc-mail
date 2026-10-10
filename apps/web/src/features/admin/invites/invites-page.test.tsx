import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }));
vi.mock('@/api/resources', () => ({
  adminApi: { listInvites: vi.fn(async () => []), getSettings: mocks.getSettings, revokeInvite: vi.fn() },
}));

import { InvitesPage } from './invites-page';

function mount(mode: 'closed' | 'invite' | 'open') {
  mocks.getSettings.mockResolvedValue({ register_mode: mode });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InvitesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

describe('邀请码页注册模式提示', () => {
  it('开放注册时提示邀请码不生效，并链接到系统设置', async () => {
    const client = mount('open');
    expect(await screen.findByText('当前为开放注册，邀请码不生效。')).toBeInTheDocument();
    expect(screen.getByText('开放')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前往系统设置修改' })).toHaveAttribute('href', '/admin/settings');
    client.clear();
  });

  it('关闭注册时提示邀请码不能用于注册', async () => {
    const client = mount('closed');
    expect(await screen.findByText('当前已关闭注册，邀请码不能用于注册。')).toBeInTheDocument();
    client.clear();
  });

  it('邀请码模式只显示当前模式，不出警示', async () => {
    const client = mount('invite');
    expect(await screen.findByText('邀请码')).toBeInTheDocument();
    expect(screen.queryByText(/不生效|不能用于注册/)).toBeNull();
    client.clear();
  });
});
