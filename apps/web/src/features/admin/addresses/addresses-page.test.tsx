import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { AddressesPage } from './addresses-page';

const mocks = vi.hoisted(() => ({ transfer: vi.fn(), search: vi.fn(), toast: vi.fn() }));
const box = { id: 42, address: 'existing@example.com', domain: 'example.com', userId: 10, ownerUsername: 'old-owner',
  displayName: '', messageCount: 12, createdAt: '2026-10-06T00:00:00Z' };
vi.mock('@/api/resources', () => ({ adminApi: { searchUsers: mocks.search, transferMailbox: mocks.transfer }, mailboxApi: { release: vi.fn() } }));
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
  mocks.search.mockImplementation(async (q: string) => ({ items: [
    { id: 20, username: 'new-owner', role: 'user' },
    { id: 40, username: 'another-admin', role: 'admin' },
  ].filter(user => user.username.includes(q)), hasMore: false }));
  mocks.transfer.mockResolvedValue({ mailbox: { ...box, userId: 20, ownerUsername: 'new-owner' }, transferred: true, revokedShares: 2 });
});

describe('全站地址邮箱过户', () => {
  it('必须选启用中的新主人并确认，提交当前主人快照，成功后刷新归属及私信缓存', async () => {
    const { client, reset, invalidate, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    expect(screen.getByRole('button', { name: '确认过户' })).toBeDisabled();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText(/旧共享授权将全部撤销/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /目标用户/ }), { target: { value: 'NEW' } });
    fireEvent.click(await screen.findByRole('option', { name: /new-owner/ }));
    expect(mocks.search).toHaveBeenCalledWith('new', 10, expect.any(AbortSignal));
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
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('option', { name: /new-owner/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '邮箱归属已改变，请刷新后重新确认', variant: 'error' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mailboxes'] });
    view.unmount(); client.clear();
  });

  it('用户列表加载失败时不能提交，并能重试', async () => {
    mocks.search.mockRejectedValue(new Error('用户搜索暂不可用'));
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    await screen.findByRole('button', { name: '重新加载' });
    expect(screen.getByRole('button', { name: '确认过户' })).toBeDisabled();
    expect(mocks.transfer).not.toHaveBeenCalled();
    mocks.search.mockResolvedValue({ items: [{ id: 20, username: 'new-owner', role: 'user' }], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('option', { name: /new-owner/ });
    view.unmount(); client.clear();
  });

  it('支持无匹配提示和键盘选择管理员，修改搜索会清除已选目标', async () => {
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'missing' } });
    await screen.findByText('没有匹配的可过户用户。');
    fireEvent.change(input, { target: { value: 'admin' } });
    await screen.findByRole('option', { name: /another-admin.*管理员/ });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('已选择：another-admin（管理员）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认过户' })).toBeEnabled();
    fireEvent.change(input, { target: { value: 'new' } });
    expect(screen.getByRole('button', { name: '确认过户' })).toBeDisabled();
    expect(screen.queryByText(/已选择/)).toBeNull();
    await screen.findByRole('option', { name: /new-owner/ });
    view.unmount(); client.clear();
  });

  it('新搜索结果就绪后，旧请求晚返回不能替换结果或错误选中用户', async () => {
    let finishOld!: (value: unknown) => void;
    mocks.search.mockImplementation((q: string) => q === 'old' ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve({ items: [{ id: 20, username: 'new-owner', role: 'user' }], hasMore: true }));
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'old' } });
    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('old', 10, expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    await screen.findByRole('option', { name: /new-owner/ });
    expect(screen.getByText(/请继续输入更完整的用户名/)).toBeInTheDocument();
    finishOld({ items: [{ id: 99, username: 'old-match', role: 'user' }], hasMore: false });
    fireEvent.click(screen.getByRole('option', { name: /new-owner/ }));
    expect(screen.queryByRole('option', { name: /old-match/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(42, { userId: 20, expectedOwnerId: 10 }));
    view.unmount(); client.clear();
  });

  it('之前的精确搜索失败后，仍能选择片段搜索找到的同一用户', async () => {
    mocks.search.mockImplementation(async (q: string) => {
      if (q === 'new-owner') throw new Error('临时搜索失败');
      return { items: [{ id: 20, username: 'new-owner', role: 'user' }], hasMore: false };
    });
    const { client, view } = mount();
    fireEvent.click(screen.getByRole('button', { name: `过户 ${box.address}` }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new-owner' } });
    await screen.findByRole('button', { name: '重新加载' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('option', { name: /new-owner/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认过户' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(42, { userId: 20, expectedOwnerId: 10 }));
    view.unmount(); client.clear();
  });
});
