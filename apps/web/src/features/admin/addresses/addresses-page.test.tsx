import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { AddressesPage } from './addresses-page';

const mocks = vi.hoisted(() => ({ transfer: vi.fn(), users: vi.fn(), toast: vi.fn() }));
const box = { id: 42, address: 'existing@example.com', domain: 'example.com', userId: 10, ownerUsername: 'old-owner',
  displayName: '', messageCount: 12, createdAt: '2026-10-06T00:00:00Z' };
vi.mock('@/api/resources', () => ({ adminApi: { listUsers: mocks.users, transferMailbox: mocks.transfer }, mailboxApi: { release: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: [box], isLoading: false, isError: false }) }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const reset = vi.spyOn(client, 'resetQueries');
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  return { client, reset, invalidate, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.mockResolvedValue([
    { id: 10, username: 'old-owner', role: 'user', status: 'active' },
    { id: 20, username: 'new-owner', role: 'user', status: 'active' },
    { id: 30, username: 'disabled-user', role: 'user', status: 'disabled' },
    { id: 40, username: 'another-admin', role: 'admin', status: 'active' },
  ]);
  mocks.transfer.mockResolvedValue({ mailbox: { ...box, userId: 20, ownerUsername: 'new-owner' }, transferred: true, revokedShares: 2 });
});

describe('全站地址邮箱过户', () => {
  it('必须选启用中的新主人并确认，提交当前主人快照，成功后刷新归属及私信缓存', async () => {
    const { client, reset, invalidate, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    expect(screen.getByRole('button', { name: '确认过户' })).toBeDisabled();
    await screen.findByRole('option', { name: 'new-owner' });
    expect(screen.queryByRole('option', { name: 'old-owner' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'disabled-user' })).toBeNull();
    expect(screen.getByRole('option', { name: 'another-admin（管理员）' })).toBeInTheDocument();
    expect(screen.getByText(/旧共享授权将全部撤销/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /目标用户/ }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(42, { userId: 20, expectedOwnerId: 10 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(reset).toHaveBeenCalledWith({ queryKey: ['messages'] });
    for (const queryKey of [['mailboxes'], ['admin', 'users'], ['admin', 'mailbox-shares']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
    view.unmount(); client.clear();
  });

  it('主人已改变时保留服务器错误提示，刷新列表并停止陈旧确认', async () => {
    mocks.transfer.mockRejectedValue(new ApiError('邮箱归属已改变，请刷新后重新确认', { code: 'conflict', httpStatus: 409 }));
    const { client, invalidate, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    await screen.findByRole('option', { name: 'new-owner' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '邮箱归属已改变，请刷新后重新确认', variant: 'error' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    view.unmount(); client.clear();
  });

  it('用户列表加载失败时不能提交，并能重试', async () => {
    mocks.users.mockRejectedValue(new Error('用户列表暂不可用'));
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    await screen.findByRole('button', { name: '重新加载' });
    expect(screen.getByRole('button', { name: '确认过户' })).toBeDisabled();
    expect(mocks.transfer).not.toHaveBeenCalled();
    mocks.users.mockResolvedValue([{ id: 20, username: 'new-owner', role: 'user', status: 'active' }]);
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('option', { name: 'new-owner' });
    view.unmount(); client.clear();
  });
});
