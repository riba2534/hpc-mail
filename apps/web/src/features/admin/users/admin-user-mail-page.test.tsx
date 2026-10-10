import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/resources', () => ({
  adminApi: {
    listUsers: vi.fn(async () => [
      {
        id: 7,
        username: 'alice',
        role: 'user',
        status: 'active',
        mailboxCount: 3,
        mailboxes: ['a@zeta.example', 'b@alpha.example', 'c@zeta.example'],
        apiKeyCount: 0,
        createdAt: '2026-10-01T00:00:00Z',
        lastLoginAt: null,
        avatarUrl: null,
      },
    ]),
  },
}));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['alpha.example', 'zeta.example', 'other.example'] }) }));
vi.mock('@/features/inbox/mail-list', () => ({ MailList: () => <p>列表</p> }));

import { AdminUserMailPage, ownedDomains } from './admin-user-mail-page';

describe('管理员查看用户邮件的域名筛选', () => {
  it('ownedDomains 从地址取域名并去重排序', () => {
    expect(ownedDomains(['x@b.com', 'y@A.com', 'z@b.com'])).toEqual(['a.com', 'b.com']);
    expect(ownedDomains([])).toEqual([]);
  });

  it('域名标签只显示该用户实际拥有的域名', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/admin/users/7/mail']}>
          <Routes>
            <Route path="/admin/users/:userId/mail" element={<AdminUserMailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('alice 的邮件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'alpha.example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'zeta.example' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'other.example' })).toBeNull();
    client.clear();
  });
});
