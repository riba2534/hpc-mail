import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminUser } from '@hpc-mail/shared';
import { ResetPasswordDialog } from './users-page';

vi.mock('@/api/resources', () => ({
  adminApi: {
    updateUser: vi.fn(),
  },
}));

function user(id: number, username: string): AdminUser {
  return {
    id,
    username,
    role: 'user',
    status: 'active',
    mailboxCount: 0,
    mailboxes: [],
    apiKeyCount: 0,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    avatarUrl: null,
  };
}

describe('ResetPasswordDialog', () => {
  it('切换目标和重新打开时都会生成新的临时密码', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ResetPasswordDialog target={user(1, 'alice')} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    const password = () => document.querySelector('code')?.textContent ?? '';
    await waitFor(() => expect(password()).toHaveLength(14));
    const first = password();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ResetPasswordDialog target={user(2, 'bob')} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(password()).not.toBe(first));
    const second = password();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ResetPasswordDialog target={null} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ResetPasswordDialog target={user(2, 'bob')} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(password()).not.toBe(second));
  });
});
