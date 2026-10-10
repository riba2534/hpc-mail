import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiKeySummary } from '@hpc-mail/shared';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mobile: true }));
const key: ApiKeySummary = {
  id: 3,
  name: '收信脚本',
  keyPrefix: 'hpcm_ab',
  keySuffix: 'yz',
  scopes: ['mail.read', 'mailbox.read'],
  rateLimit: 120,
  allowedIps: [],
  status: 'active',
  expiresAt: null,
  lastUsedAt: null,
  createdAt: '2026-10-10T00:00:00Z',
};
vi.mock('@/api/resources', () => ({ apiKeyApi: { list: async () => [key], listAll: async () => [] } }));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => ({ id: 1, username: 'alice', role: 'user' }) }));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));

import { ApiKeysPage } from './api-keys-page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ApiKeysPage />
    </QueryClientProvider>,
  );
}

describe('ApiKeysPage 窄屏', () => {
  it('以卡片展示密钥，操作收进更多菜单', async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('收信脚本')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('2 项权限')).toBeInTheDocument();
    expect(screen.getByText('从未使用')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    expect(await screen.findByRole('menuitem', { name: '审计日志' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '停用' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '删除密钥' }));
    expect(await screen.findByText('删除这个密钥？')).toBeInTheDocument();
  });

  it('宽屏保留表格', async () => {
    mocks.mobile = false;
    renderPage();
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
