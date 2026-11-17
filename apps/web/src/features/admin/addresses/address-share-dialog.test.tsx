import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { MailboxShareGrant } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';

const mocks = vi.hoisted(() => ({ list: vi.fn(), replace: vi.fn(), toast: vi.fn(), get: vi.fn(), mobile: false }));
const grants: MailboxShareGrant[] = [
  {
    mailboxId: 1, address: 'first@example.com', domain: 'example.com', displayName: '',
    ownerUserId: 99, ownerUsername: 'first-owner',
    grantees: [{ userId: 2, username: 'disabled-old', status: 'disabled', grantedAt: '2026-10-01' }],
  },
  {
    mailboxId: 7, address: 'second@example.com', domain: 'example.com', displayName: '',
    ownerUserId: 100, ownerUsername: 'second-owner',
    grantees: [{ userId: 3, username: 'active-member', status: 'active', grantedAt: '2026-10-01' }],
  },
];
vi.mock('@/api/resources', () => ({
  adminApi: {
    listMailboxShares: mocks.list,
    listUsers: vi.fn(async () => [
      { id: 2, username: 'disabled-old', role: 'user', status: 'disabled' },
      { id: 3, username: 'active-member', role: 'user', status: 'active' },
      { id: 4, username: 'active-admin', role: 'admin', status: 'active' },
    ]),
    replaceMailboxShares: mocks.replace,
  },
  mailboxApi: { release: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));
import { AddressesPage } from './addresses-page';
import { fakeAdminMailboxesApi } from './fake-admin-mailboxes';

const boxes = grants.map(grant => ({ id: grant.mailboxId, address: grant.address, domain: grant.domain, userId: grant.ownerUserId,
  ownerUsername: grant.ownerUsername, displayName: '', messageCount: 12, createdAt: '2026-10-06T00:00:00Z' }));

// jsdom 未实现 scrollTo：窗口虚拟列表挂载时会把滚动位置同步一次
window.scrollTo = vi.fn() as typeof window.scrollTo;

/** 后端按 mailboxId 过滤：只返回该邮箱（0 或 1 项） */
const sharesOf = async (mailboxId?: number) => grants.filter((grant) => grant.mailboxId === mailboxId);

function mount(seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.get.mockImplementation(fakeAdminMailboxesApi(boxes));
  mocks.list.mockImplementation(sharesOf);
  mocks.replace.mockImplementation(async ({ userIds }: { userIds: number[] }) => ({ grantees: userIds.map(userId => ({ userId })) }));
});

describe('按地址行共享邮箱', () => {
  it('点击第二行直接编辑该邮箱，保留现有成员并只提交该邮箱的共享', async () => {
    const { client, view } = mount();
    const share = await screen.findByRole('button', { name: '共享邮箱 second@example.com' });
    expect(mocks.list).not.toHaveBeenCalled();
    fireEvent.click(share);
    const member = await screen.findByRole('checkbox', { name: 'active-member' });
    // 只按这一个邮箱读共享名单，缓存在该邮箱自己的 key 下
    expect(mocks.list.mock.calls).toEqual([[7]]);
    expect(client.getQueryData(queryKeys.admin.mailboxSharesOf(7))).toEqual([grants[1]]);
    expect(client.getQueryData(queryKeys.admin.mailboxShares)).toBeUndefined();
    const dialog = screen.getByRole('dialog', { name: '共享邮箱' });
    expect(within(dialog).getByText('second@example.com')).toBeInTheDocument();
    expect(within(dialog).queryByText('first@example.com')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(member).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'active-admin' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [3, 4], expectedOwnerId: 100 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    view.unmount(); client.clear();
  });

  it('关闭后保留地址筛选并将焦点还给当前行按钮', async () => {
    const user = userEvent.setup();
    const { client, view } = mount();
    await screen.findByRole('button', { name: '共享邮箱 second@example.com' });
    await user.type(screen.getByPlaceholderText('搜索地址或用户名'), 'second-owner');
    await waitFor(() => expect(screen.queryByRole('button', { name: '共享邮箱 first@example.com' })).toBeNull());
    await user.click(screen.getByRole('button', { name: '共享邮箱 second@example.com' }));
    await screen.findByRole('checkbox', { name: 'active-member' });
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByPlaceholderText('搜索地址或用户名')).toHaveValue('second-owner');
    await waitFor(() => expect(screen.getByRole('button', { name: '共享邮箱 second@example.com' })).toHaveFocus());
    view.unmount(); client.clear();
  });

  it('切换到另一行不会沿用之前未保存的成员，允许移除失效成员', async () => {
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'active-admin' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 first@example.com' }));
    const invalid = await screen.findByRole('checkbox', { name: /disabled-old/ });
    expect(invalid).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'active-admin' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(invalid);
    fireEvent.click(screen.getByRole('checkbox', { name: 'active-member' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 1, userIds: [3], expectedOwnerId: 99 }));
    view.unmount(); client.clear();
  });

  it('编辑中遇到后台刷新（如其他写操作触发失效）：不卸载、不重置未保存的勾选，保存仍按打开时的所有者校验', async () => {
    // TanStack 用 setTimeout 合批通知订阅者：让出一个宏任务，界面才会反映查询状态
    const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'active-member' }));
    expect(screen.getByRole('checkbox', { name: 'active-member' })).not.toBeChecked();

    let finish!: (value: MailboxShareGrant[]) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    void client.invalidateQueries({ queryKey: queryKeys.admin.mailboxShares });
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    // 刷新进行中：仍是编辑中的弹窗，没有闪回加载态
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'active-member' })).not.toBeChecked();

    // 刷新回来的名单仍含该成员，且所有者已变：编辑中的弹窗不能被它替换
    finish([{ ...grants[1]!, ownerUserId: 200, ownerUsername: 'new-owner' }]);
    await flush();
    expect(client.getQueryData(queryKeys.admin.mailboxSharesOf(7))).toMatchObject([{ ownerUserId: 200 }]);
    expect(screen.getByText('邮箱所有者：second-owner')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'active-member' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [], expectedOwnerId: 100 }));
    view.unmount(); client.clear();
  });

  it('可取消全部成员来撤销当前邮箱的共享', async () => {
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'active-member' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [], expectedOwnerId: 100 }));
    view.unmount(); client.clear();
  });

  it('名单加载失败不能用空名单覆盖，重试后仍打开指定邮箱', async () => {
    mocks.list.mockRejectedValueOnce(new Error('network unavailable'));
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    await screen.findByRole('button', { name: '重新加载' });
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('checkbox', { name: 'active-member' })).toBeChecked();
    expect(mocks.list.mock.calls).toEqual([[7], [7]]);
    view.unmount(); client.clear();
  });

  it('该邮箱已释放（名单为空）时提示刷新，不能编辑', async () => {
    mocks.list.mockResolvedValueOnce([]);
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    expect(await screen.findByText('该邮箱已释放或不存在，请关闭并刷新地址列表。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    view.unmount(); client.clear();
  });

  it('缓存的名单已失效（如刚过户）时，等刷新完成再进入编辑，不拿旧成员覆盖', async () => {
    let finish!: (value: MailboxShareGrant[]) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { client, view } = mount((c) => {
      c.setQueryData(queryKeys.admin.mailboxSharesOf(7), [grants[1]]);
      void c.invalidateQueries({ queryKey: queryKeys.admin.mailboxShares });
    });
    fireEvent.click(await screen.findByRole('button', { name: '共享邮箱 second@example.com' }));
    expect(await screen.findByRole('status')).toHaveTextContent('正在加载共享名单…');
    expect(screen.queryByRole('checkbox', { name: 'active-member' })).toBeNull();
    finish([{ ...grants[1]!, ownerUserId: 200, ownerUsername: 'new-owner', grantees: [] }]);
    expect(await screen.findByText('邮箱所有者：new-owner')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'active-member' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ mailboxId: 7, userIds: [], expectedOwnerId: 200 }));
    view.unmount(); client.clear();
  });

  it('窄屏卡片的共享操作直接打开当前邮箱', async () => {
    mocks.mobile = true;
    const { client, view } = mount();
    await screen.findByText('second@example.com');
    fireEvent.keyDown(screen.getAllByRole('button', { name: '更多操作' })[1]!, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '共享邮箱' }));
    await screen.findByRole('checkbox', { name: 'active-member' });
    expect(within(screen.getByRole('dialog')).getByText('second@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount(); client.clear();
  });
});
