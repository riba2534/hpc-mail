import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ mode: 'closed' as 'closed' | 'invite' | 'open' }));

vi.mock('@/lib/use-config', () => ({
  usePublicConfig: () => ({
    data: { siteTitle: 'HPC Mail', registrationMode: config.mode, domains: [] },
    isLoading: false,
  }),
}));

import { LoginPage } from './login-page';

function renderPage(children: ReactNode = <LoginPage />) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage 注册模式分支', () => {
  beforeEach(() => localStorage.clear());

  it('closed 模式不显示注册入口', () => {
    config.mode = 'closed';
    renderPage();
    expect(screen.queryByRole('radio', { name: '注册' })).toBeNull();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('invite 模式的注册需要邀请码字段', async () => {
    config.mode = 'invite';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    expect(screen.getByText('邀请码')).toBeInTheDocument();
  });

  it('open 模式的注册不显示邀请码字段', async () => {
    config.mode = 'open';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    expect(screen.queryByText('邀请码')).toBeNull();
  });
});
