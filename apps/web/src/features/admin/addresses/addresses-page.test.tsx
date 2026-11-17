import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { AddressesPage } from './addresses-page';
import { fakeAdminMailboxesApi } from './fake-admin-mailboxes';

// jsdom 未实现 scrollTo：窗口虚拟列表挂载时会把滚动位置同步一次
window.scrollTo = vi.fn() as typeof window.scrollTo;

const mocks = vi.hoisted(() => ({ transfer: vi.fn(), search: vi.fn(), toast: vi.fn(), get: vi.fn() }));
const box = { id: 42, address: 'existing@example.com', domain: 'example.com', userId: 10, ownerUsername: 'old-owner',
  displayName: '', messageCount: 12, createdAt: '2026-10-06T00:00:00Z' };
vi.mock('@/api/resources', () => ({ adminApi: { searchUsers: mocks.search, transferMailbox: mocks.transfer }, mailboxApi: { release: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const reset = vi.spyOn(client, 'resetQueries');
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  return { client, reset, invalidate, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(fakeAdminMailboxesApi([box]));
  mocks.search.mockImplementation(async (q: string) => ({ items: [
    { id: 20, username: 'new-owner', role: 'user' },
    { id: 40, username: 'another-admin', role: 'admin' },
  ].filter(user => user.username.includes(q)), hasMore: false }));
  mocks.transfer.mockResolvedValue({ mailbox: { ...box, userId: 20, ownerUsername: 'new-owner' }, transferred: true, revokedShares: 2 });
});

describe('全站地址邮箱过户', () => {
  it('必须选启用中的新主人并确认，提交当前主人快照，成功后刷新归属及私信缓存', async () => {
    const { client, reset, invalidate, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
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
    // 全站分页挂在 mailboxes 根下：所有权失效后已加载的页随之重拉
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    view.unmount(); client.clear();
  });

  it('主人已改变时保留服务器错误提示，刷新列表并停止陈旧确认', async () => {
    mocks.transfer.mockRejectedValue(new ApiError('邮箱归属已改变，请刷新后重新确认', { code: 'conflict', httpStatus: 409 }));
    const { client, invalidate, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
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
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
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
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
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
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
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
    fireEvent.click(await screen.findByRole('button', { name: `过户 ${box.address}` }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new-owner' } });
    await screen.findByRole('button', { name: '重新加载' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new' } });
    fireEvent.click(await screen.findByRole('option', { name: /new-owner/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认过户' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '确认过户' }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledWith(42, { userId: 20, expectedOwnerId: 10 }));
    view.unmount(); client.clear();
  });

  it('每个地址都有进入该邮箱收发件的入口：图标按钮与地址链接指向同一页面', async () => {
    function Where() {
      return <p data-testid="where">{useLocation().pathname}</p>;
    }
    const client = new QueryClient();
    const router = createMemoryRouter(
      [
        { path: '/admin/addresses', element: <AddressesPage /> },
        { path: '/admin/addresses/:mailboxId/mail', element: <Where /> },
      ],
      { initialEntries: ['/admin/addresses'] },
    );
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: box.address })).toHaveAttribute('href', '/admin/addresses/42/mail');
    fireEvent.click(screen.getByRole('button', { name: `查看邮件 ${box.address}` }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/admin/addresses/42/mail');
    client.clear();
  });
});

describe('全站地址分页加载', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...box, id: 500 - i, address: `p${i}@example.com` }));
  /** 记录观察器，由测试决定列表末尾何时进入视口 */
  const observers: { callback: IntersectionObserverCallback; target: Element | null }[] = [];
  class ManualObserver {
    private readonly entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, target: null };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.target = target; }
    unobserve() {}
    disconnect() { this.entry.target = null; }
    takeRecords() { return []; }
  }
  const reachEnd = () => act(() => {
    const live = observers.filter((observer) => observer.target);
    for (const { callback, target } of live) {
      callback([{ isIntersecting: true, target } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    observers.length = 0;
  });

  it('首屏只取一页（all=1&limit=100）；末尾进入视口时用 nextCursor 取下一页，取完后不再请求', async () => {
    mocks.get.mockImplementation(fakeAdminMailboxesApi(many));
    vi.stubGlobal('IntersectionObserver', ManualObserver);
    const { client, view } = mount();
    // jsdom 没有布局，行高为 0，虚拟列表渲染哪些行不固定：用表格声明的总行数判断加载进度
    const table = await screen.findByRole('table');
    expect(mocks.get.mock.calls).toEqual([['/mailboxes', {
      query: { all: 1, q: undefined, domain: undefined, cursor: '', limit: 100 }, signal: expect.any(AbortSignal) }]]);
    // 还有下一页时总行数未知
    expect(table).toHaveAttribute('aria-rowcount', '-1');
    reachEnd();
    await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', '151'));
    expect(mocks.get.mock.calls.map(([, options]) => options.query.cursor)).toEqual(['', '100']);
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull();
    reachEnd();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    view.unmount(); client.clear();
  });

  it('没有 IntersectionObserver 时用「加载更多」按钮翻页；搜索词防抖后交给服务端', async () => {
    mocks.get.mockImplementation(fakeAdminMailboxesApi(many));
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '151'));
    // 连续输入（间隔短于防抖时长）只按最终的词请求一次
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'P14' } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'P149' } });
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '2'));
    expect(screen.getByRole('link', { name: 'p149@example.com' })).toBeInTheDocument();
    expect(mocks.get.mock.calls.slice(2).map(([, options]) => options.query)).toEqual([
      { all: 1, q: 'p149', domain: undefined, cursor: '', limit: 100 },
    ]);
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'nothing' } });
    expect(await screen.findByText('没有匹配的地址')).toBeInTheDocument();
    view.unmount(); client.clear();
  });

  it('翻页失败时保留已加载的地址，重试只补取下一页', async () => {
    const api = fakeAdminMailboxesApi(many);
    mocks.get.mockImplementation(api).mockImplementationOnce(api).mockRejectedValueOnce(new Error('翻页失败'));
    const { client, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '加载更多' }));
    const retry = await screen.findByRole('button', { name: '重新加载' });
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '-1');
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '151'));
    expect(mocks.get.mock.calls.map(([, options]) => options.query.cursor)).toEqual(['', '100', '100']);
    view.unmount(); client.clear();
  });
});
