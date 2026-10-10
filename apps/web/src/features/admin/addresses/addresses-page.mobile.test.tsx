import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const box = { id: 42, address: 'existing@example.com', domain: 'example.com', userId: 10, ownerUsername: 'old-owner',
  displayName: '', messageCount: 12, createdAt: '2026-10-06T00:00:00Z' };
vi.mock('@/api/resources', () => ({ adminApi: { searchUsers: vi.fn(), transferMailbox: vi.fn() }, mailboxApi: { release: vi.fn() } }));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => true }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: [box], isLoading: false, isError: false }) }));

import { AddressesPage } from './addresses-page';

describe('全站地址窄屏卡片', () => {
  it('窄屏渲染卡片而非表格，操作收进更多菜单', async () => {
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('existing@example.com')).toBeInTheDocument();
    expect(screen.getByText('归属 old-owner')).toBeInTheDocument();
    expect(screen.getByText('12 封邮件')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '强制释放' }));
    expect(await screen.findByRole('dialog', { name: '强制释放地址' })).toBeInTheDocument();
    client.clear();
  });
});
