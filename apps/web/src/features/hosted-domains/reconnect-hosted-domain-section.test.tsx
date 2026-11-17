import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain, SessionUser } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { CurrentUserContext } from '@/lib/use-session';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  reconnect: vi.fn(),
  members: vi.fn(),
  dnsRecords: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./hosted-domains-api', () => ({
  hostedDomainApi: { get: mocks.get, reconnect: mocks.reconnect, members: mocks.members, dnsRecords: mocks.dnsRecords },
}));
vi.mock('@/api/resources', () => ({ mailboxApi: { searchShareUsers: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-config', () => ({ usePublicConfig: () => ({ data: { hostedDomainsEnabled: true } }) }));
import { HostedDomainDetailPage } from './hosted-domain-detail-page';

const alice: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

const moved = (patch: Partial<HostedDomain> = {}): HostedDomain => ({
  id: 1, domain: 'mine.example', status: 'moved', role: 'owner', ownerUserId: 1, ownerUsername: 'alice',
  nameServers: ['old-a.ns.cloudflare.com', 'old-b.ns.cloudflare.com'],
  originalNameServers: ['ns1.registrar.example'], originalRegistrar: 'Example Registrar',
  steps: { nameServers: 'error', routing: 'ready', catchAll: 'ready', sending: 'ready' },
  warnings: ['Cloudflare 中该域名的 zone 已被删除，收发已停止。'], lastError: 'Cloudflare 中的 zone 已不存在',
  memberLimit: 0, memberCount: 0, mailboxCount: 3, createdAt: '2026-10-01T00:00:00Z', activatedAt: '2026-10-01T01:00:00Z',
  checkedAt: '2026-11-10T00:00:00Z', expiresAt: null, ...patch,
});

function mount(user: SessionUser = alice) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: '/domains/:id', element: <HostedDomainDetailPage /> }], { initialEntries: ['/domains/1'] });
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <RouterProvider router={router} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

describe('重新接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dnsRecords.mockResolvedValue([]);
    mocks.members.mockResolvedValue([]);
  });

  it('所有者确认后重新接入，显示新分配的名称服务器', async () => {
    mocks.get.mockResolvedValue(moved());
    mocks.reconnect.mockResolvedValue(moved({
      status: 'pending', nameServers: ['new-a.ns.cloudflare.com', 'new-b.ns.cloudflare.com'], warnings: [], lastError: '',
      steps: { nameServers: 'waiting', routing: 'waiting', catchAll: 'waiting', sending: 'waiting' },
    }));
    const client = mount();
    fireEvent.click(await screen.findByRole('button', { name: '重新接入' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('分配新的名称服务器')).toBeInTheDocument();
    expect(dialog.getByText(/地址、历史邮件和成员都会保留/)).toBeInTheDocument();
    expect(mocks.reconnect).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: '重新接入' }));
    await waitFor(() => expect(mocks.reconnect).toHaveBeenCalledWith(1));
    const nameServers = within(await screen.findByRole('list', { name: '本站分配的名称服务器' }));
    expect(await nameServers.findByText('new-a.ns.cloudflare.com')).toBeInTheDocument();
    expect(nameServers.queryByText('old-a.ns.cloudflare.com')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '已重新接入', variant: 'success' }));
    // 回到等待修改 NS 后不再提供重新接入
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新接入' })).toBeNull());
    client.clear();
  });

  it('zone 仍在、NS 还没改回时提示已复查；失败给出服务端原因', async () => {
    mocks.get.mockResolvedValue(moved());
    mocks.reconnect.mockResolvedValueOnce(moved({ checkedAt: '2026-11-17T00:00:00Z' }));
    const client = mount({ ...alice, id: 9, username: 'root', role: 'admin' });
    fireEvent.click(await screen.findByRole('button', { name: '重新接入' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '重新接入' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '已请 Cloudflare 复查名称服务器' })));

    mocks.reconnect.mockRejectedValueOnce(new ApiError('站长账户中已有同名 zone，不能接管', { code: 'conflict', httpStatus: 409 }));
    fireEvent.click(screen.getByRole('button', { name: '重新接入' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '重新接入' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '站长账户中已有同名 zone，不能接管', variant: 'error' }));
    client.clear();
  });

  it('成员与未迁走的域名不显示重新接入', async () => {
    mocks.get.mockResolvedValue(moved({ role: 'member', ownerUserId: 9, ownerUsername: 'bob' }));
    let client = mount({ ...alice, id: 3, username: 'carol' });
    expect(await screen.findByRole('heading', { name: 'mine.example', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新接入' })).toBeNull();
    client.clear();
    document.body.innerHTML = '';

    mocks.get.mockResolvedValue(moved({ status: 'active', warnings: [], lastError: '' }));
    client = mount();
    expect(await screen.findByRole('button', { name: '立即检测' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新接入' })).toBeNull();
    client.clear();
  });
});
