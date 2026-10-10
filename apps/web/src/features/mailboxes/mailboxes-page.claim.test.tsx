import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/api/resources', () => ({ mailboxApi: { availability: vi.fn(async () => ({ available: true })) } }));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['example.com'] }) }));
vi.mock('./use-mailboxes', () => ({
  useMailboxesQuery: () => ({
    data: [{ id: 9, address: 'me+tag@example.com', domain: 'example.com', displayName: '', messageCount: 3, createdAt: '2026-10-05T00:00:00Z' }],
    isLoading: false,
    isError: false,
  }),
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
import { MailboxesPage } from './mailboxes-page';

function renderPage(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/mailboxes', element: <MailboxesPage /> }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('我的邮箱', () => {
  it('?claim=1 自动打开认领对话框并从 URL 去掉参数', async () => {
    const { client, router } = renderPage('/mailboxes?claim=1');
    expect(await screen.findByRole('dialog', { name: '认领邮箱地址' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
    client.clear();
  });

  it('地址链接到只看该地址的收件箱，旁边可复制', () => {
    const { client } = renderPage('/mailboxes');
    expect(screen.getByRole('link', { name: 'me+tag@example.com' })).toHaveAttribute(
      'href',
      '/inbox?address=me%2Btag%40example.com',
    );
    expect(screen.getByRole('button', { name: '复制 me+tag@example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    client.clear();
  });
});
