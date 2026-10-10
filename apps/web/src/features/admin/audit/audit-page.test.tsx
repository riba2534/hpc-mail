import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdminAuditLogEntry } from '@hpc-mail/shared';

function entry(id: number, action: string, target: string, detail = '', actorName = 'root'): AdminAuditLogEntry {
  return { id, actorName, action, target, detail, ip: '203.0.113.9', createdAt: '2026-10-08T00:00:00Z' };
}

const LOGS = [
  entry(3, 'mailbox.transfer', 'box@example.com', '从 alice 过户给 bob'),
  entry(2, 'user.delete', 'carol'),
  entry(1, 'custom.thing', 'misc', '', 'ops'),
];

vi.mock('@/api/resources', () => ({
  adminApi: { auditLogs: vi.fn(async () => ({ items: LOGS, nextCursor: 'next' })) },
}));

import { AuditPage, filterAuditLogs } from './audit-page';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuditPage />
    </QueryClientProvider>,
  );
  return client;
}

describe('filterAuditLogs', () => {
  it('按操作类型精确匹配，并按操作人/目标/详情关键字过滤（不区分大小写）', () => {
    expect(filterAuditLogs(LOGS, 'all', '').map((log) => log.id)).toEqual([3, 2, 1]);
    expect(filterAuditLogs(LOGS, 'user.delete', '').map((log) => log.id)).toEqual([2]);
    expect(filterAuditLogs(LOGS, 'all', 'BOB').map((log) => log.id)).toEqual([3]);
    expect(filterAuditLogs(LOGS, 'all', 'ops').map((log) => log.id)).toEqual([1]);
    expect(filterAuditLogs(LOGS, 'user.delete', 'box')).toEqual([]);
  });
});

describe('AuditPage 筛选', () => {
  it('关键字筛选只作用于已加载记录，并保留加载更多', async () => {
    const client = mount();
    await screen.findByText('box@example.com');
    expect(screen.getByText('过户邮箱')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索操作人、目标或详情' }), { target: { value: 'carol' } });
    expect(screen.queryByText('box@example.com')).toBeNull();
    expect(screen.getByText('carol')).toBeInTheDocument();
    expect(screen.getByText(/仅筛选已加载的 3 条记录，匹配 1 条/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加载更多' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索操作人、目标或详情' }), { target: { value: 'nothing-matches' } });
    expect(screen.getByText('没有匹配的记录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('box@example.com')).toBeInTheDocument();
    client.clear();
  });

  it('操作类型下拉含已知动作与记录中出现的未知动作，选择后只显示该类', async () => {
    const client = mount();
    await screen.findByText('box@example.com');
    fireEvent.click(screen.getByRole('combobox', { name: '按操作类型筛选' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'custom.thing' })).toBeInTheDocument();
    fireEvent.click(within(listbox).getByRole('option', { name: '删除用户' }));
    expect(screen.queryByText('box@example.com')).toBeNull();
    expect(screen.getByText('carol')).toBeInTheDocument();
    client.clear();
  });
});
