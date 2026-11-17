import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';

const mocks = vi.hoisted(() => ({
  getMailbox: vi.fn(),
  lastQuery: { current: null as Record<string, unknown> | null },
  lastProps: { current: null as { readOnly?: boolean; hasActiveFilters?: boolean } | null },
}));
const box = {
  id: 42,
  address: 'existing@example.com',
  domain: 'example.com',
  userId: 10,
  ownerUsername: 'old-owner',
  displayName: '',
  messageCount: 12,
  createdAt: '2026-10-06T00:00:00Z',
};
vi.mock('@/api/resources', () => ({ adminApi: { getMailbox: mocks.getMailbox } }));
vi.mock('@/features/inbox/mail-list', () => ({
  MailList: (props: { query: Record<string, unknown>; readOnly?: boolean; hasActiveFilters?: boolean; emptyTitle: string }) => {
    mocks.lastQuery.current = props.query;
    mocks.lastProps.current = props;
    return <p data-testid="mail-list">{props.emptyTitle}</p>;
  },
}));

import { AdminAddressMailPage } from './address-mail-page';
import { adminMailboxesQueryOptions } from './admin-mailboxes';

/** 全站地址页已加载的分页缓存（任一搜索词下的任一页都算） */
function seedPages(client: QueryClient, pages: (typeof box)[][], q?: string) {
  client.setQueryData(adminMailboxesQueryOptions({ q }).queryKey, {
    pages: pages.map((items, i) => ({ items, nextCursor: i < pages.length - 1 ? String(i + 1) : null })),
    pageParams: pages.map((_, i) => (i ? String(i) : '')),
  });
}

function Probe() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function mount(initial: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  const router = createMemoryRouter(
    [
      { path: '/admin/addresses', element: <Probe /> },
      { path: '/admin/users/:userId/mail', element: <Probe /> },
      { path: '/admin/addresses/:mailboxId/mail', element: <AdminAddressMailPage /> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lastQuery.current = null;
  mocks.lastProps.current = null;
  mocks.getMailbox.mockImplementation(async (id: number) => {
    if (id === box.id) return box;
    throw new ApiError('邮箱不存在', { code: 'not_found', httpStatus: 404 });
  });
});

describe('管理员查看单个地址的收发件', () => {
  it('以只读方式按归属人 + 固定地址查询收件箱，并展示归属与邮件数', async () => {
    const { client } = mount('/admin/addresses/42/mail');
    expect(await screen.findByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    expect(mocks.getMailbox).toHaveBeenCalledWith(42);
    expect(client.getQueryData(queryKeys.mailboxes.adminDetail(42))).toEqual(box);
    expect(screen.getByRole('link', { name: 'old-owner' })).toHaveAttribute('href', '/admin/users/10/mail');
    expect(screen.getByText(/共 12 封邮件/)).toBeInTheDocument();
    expect(mocks.lastQuery.current).toEqual({
      direction: 'inbound',
      scope: 'user',
      userId: 10,
      address: 'existing@example.com',
      unread: undefined,
      q: undefined,
    });
    expect(mocks.lastProps.current?.readOnly).toBe(true);
    client.clear();
  });

  it('切到已发送后只换方向，仍锁定同一地址，并清掉对发件无意义的未读筛选', async () => {
    const { client, router } = mount('/admin/addresses/42/mail?unread=1');
    await screen.findByRole('heading', { name: 'existing@example.com' });
    expect(mocks.lastQuery.current).toMatchObject({ direction: 'inbound', unread: true });
    fireEvent.click(screen.getByRole('radio', { name: '已发送' }));
    expect(router.state.location.search).toContain('direction=outbound');
    expect(mocks.lastQuery.current).toMatchObject({
      direction: 'outbound',
      scope: 'user',
      userId: 10,
      address: 'existing@example.com',
      unread: undefined,
    });
    expect(screen.getByTestId('mail-list')).toHaveTextContent('该地址还没有发送记录');
    client.clear();
  });

  it('URL 里的 address/domain 不能改变被查看的地址', async () => {
    const { client } = mount('/admin/addresses/42/mail?address=other@example.com&domain=other.test&q=验证码');
    await screen.findByRole('heading', { name: 'existing@example.com' });
    expect(mocks.lastQuery.current).toMatchObject({
      address: 'existing@example.com',
      userId: 10,
      q: '验证码',
    });
    expect(mocks.lastQuery.current).not.toHaveProperty('domain');
    expect(mocks.lastProps.current?.hasActiveFilters).toBe(true);
    // 地址固定，URL 里夹带的 domain/address 也不能被当成已选筛选计数
    expect(screen.getByRole('button', { name: '筛选' })).toBeInTheDocument();
    client.clear();
  });

  it('地址已释放或不存在（404）时给出空态，并能回到全站地址', async () => {
    const { client, router } = mount('/admin/addresses/999/mail');
    expect(await screen.findByText('没有找到这个地址')).toBeInTheDocument();
    expect(mocks.getMailbox).toHaveBeenCalledWith(999);
    expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull();
    expect(screen.queryByTestId('mail-list')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /返回全站地址/ }));
    expect(await screen.findByTestId('where')).toHaveTextContent('/admin/addresses');
    expect(router.state.location.pathname).toBe('/admin/addresses');
    client.clear();
  });

  it('地址 id 非法时不请求邮箱与邮件列表', () => {
    const { client } = mount('/admin/addresses/abc/mail');
    expect(screen.getByText('无效的地址 id。')).toBeInTheDocument();
    expect(mocks.getMailbox).not.toHaveBeenCalled();
    expect(mocks.lastQuery.current).toBeNull();
    client.clear();
  });

  it('邮箱加载失败（非 404）时展示错误并可重试，不渲染邮件列表', async () => {
    mocks.getMailbox.mockRejectedValueOnce(new ApiError('服务暂不可用', { code: 'internal', httpStatus: 500 }));
    const { client } = mount('/admin/addresses/42/mail');
    fireEvent.click(await screen.findByRole('button', { name: '重新加载' }));
    expect(mocks.lastQuery.current).toBeNull();
    expect(await screen.findByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    expect(mocks.getMailbox).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('全站地址列表已在缓存里时先用列表里的这一行显示头部；邮件列表等真实数据返回后按最新归属人挂载', async () => {
    let resolve!: (value: typeof box) => void;
    mocks.getMailbox.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { client } = mount('/admin/addresses/42/mail', (c) => seedPages(c, [[{ ...box, id: 7 }], [box]]));
    expect(screen.getByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    expect(screen.getByText(/共 12 封邮件/)).toBeInTheDocument();
    expect(mocks.getMailbox).toHaveBeenCalledWith(42);
    // 列表缓存的这一行可能已过期：占位期间不按旧归属人查邮件
    expect(screen.queryByTestId('mail-list')).toBeNull();
    expect(mocks.lastQuery.current).toBeNull();
    // 期间已过户给另一个用户：邮件列表直接按新归属人查询
    resolve({ ...box, userId: 20, ownerUsername: 'new-owner', messageCount: 13 });
    expect(await screen.findByText(/共 13 封邮件/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'new-owner' })).toHaveAttribute('href', '/admin/users/20/mail');
    expect(screen.getByTestId('mail-list')).toBeInTheDocument();
    expect(mocks.lastQuery.current).toMatchObject({ userId: 20, address: 'existing@example.com' });
    client.clear();
  });

  it('列表缓存里还在、但单个邮箱已释放（404）时转为空态', async () => {
    const { client } = mount('/admin/addresses/999/mail', (c) => seedPages(c, [[{ ...box, id: 999 }]], 'exist'));
    expect(screen.getByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    expect(await screen.findByText('没有找到这个地址')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-list')).toBeNull();
    client.clear();
  });

  it('已打开的地址随后被释放：刷新返回 404 时即使还保留旧数据也转为空态', async () => {
    const { client } = mount('/admin/addresses/42/mail');
    expect(await screen.findByRole('heading', { name: 'existing@example.com' })).toBeInTheDocument();
    mocks.getMailbox.mockRejectedValue(new ApiError('邮箱不存在', { code: 'not_found', httpStatus: 404 }));
    await act(() => client.invalidateQueries({ queryKey: queryKeys.mailboxes.root }));
    expect(client.getQueryData(queryKeys.mailboxes.adminDetail(42))).toEqual(box);
    expect(await screen.findByText('没有找到这个地址')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'existing@example.com' })).toBeNull();
    expect(screen.queryByTestId('mail-list')).toBeNull();
    client.clear();
  });
});
