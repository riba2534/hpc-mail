import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), toast: vi.fn(), lastQuery: { current: null as unknown } }));
vi.mock('@/api/resources', () => ({ mailboxApi: { claim: mocks.claim } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['example.com'] }) }));
vi.mock('@/features/inbox/mail-list', () => ({
  MailList: ({ query, hasActiveFilters }: { query: unknown; hasActiveFilters: boolean }) => {
    mocks.lastQuery.current = query;
    return <p data-testid="mail-list">{hasActiveFilters ? '有筛选' : '无筛选'}</p>;
  },
}));

import { AdminMailPage } from './admin-mail-page';

function InboxProbe() {
  const location = useLocation();
  return <p>收件箱 {location.search}</p>;
}

function mount(initial = '/admin/mail') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const reset = vi.spyOn(client, 'resetQueries');
  const router = createMemoryRouter(
    [
      { path: '/admin/mail', element: <AdminMailPage /> },
      { path: '/inbox', element: <InboxProbe /> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router, reset };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ id: 1, address: 'lost@example.com' });
});

describe('全站邮件按地址筛选', () => {
  it('非法地址就地提示且不改筛选；合法地址回车后写入查询并计入筛选', async () => {
    const { client, router } = mount();
    const input = screen.getByRole('textbox', { name: '按地址筛选' });
    fireEvent.change(input, { target: { value: 'not-an-address' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('请输入完整地址');
    expect(router.state.location.search).toBe('');

    fireEvent.change(input, { target: { value: ' Lost@Example.com ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(router.state.location.search).toContain('address=lost%40example.com'));
    expect(mocks.lastQuery.current).toMatchObject({ scope: 'unclaimed', address: 'lost@example.com' });
    expect(screen.getByTestId('mail-list')).toHaveTextContent('有筛选');
    expect(screen.getByText('lost@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('address='));
    expect(input).toHaveValue('');
    client.clear();
  });

  it('「认领到我」调用认领接口，刷新归属缓存并跳到该地址的收件箱', async () => {
    const { client, router, reset } = mount('/admin/mail?address=lost%40example.com');
    fireEvent.click(await screen.findByRole('button', { name: '认领到我' }));
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith({ localPart: 'lost', domain: 'example.com' }));
    expect(await screen.findByText(/收件箱/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/inbox');
    expect(router.state.location.search).toBe('?address=lost%40example.com');
    expect(reset).toHaveBeenCalledWith({ queryKey: ['messages'] });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
    client.clear();
  });

  it('认领失败时在横幅内显示服务器错误并停留在当前页', async () => {
    mocks.claim.mockRejectedValue(new ApiError('该地址已被认领', { code: 'conflict', httpStatus: 409 }));
    const { client, router } = mount('/admin/mail?address=lost%40example.com');
    fireEvent.click(await screen.findByRole('button', { name: '认领到我' }));
    expect(await screen.findByText('该地址已被认领')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/mail');
    client.clear();
  });
});
