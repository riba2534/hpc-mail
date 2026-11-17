import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ download: vi.fn(async () => {}) }));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: true, isStarred: false,
      fromAddress: 'sender@outside.com', fromName: '', subject: `mail-${id}`,
      bodyHtml: id === 1 ? '<table><tr><td>broken</td></tr></table>' : '<p>fine</p>', bodyText: '纯文本版本',
      verificationCode: '', verificationLink: '', recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: true, createdAt: '2026-10-01T00:00:00Z',
    })),
    thread: vi.fn(async () => ({ items: [
      { id: 1, subject: 'thread-1', fromAddress: 'sender@outside.com', createdAt: '2026-10-01T00:00:00Z' },
      { id: 2, subject: 'thread-2', fromAddress: 'sender@outside.com', createdAt: '2026-10-01T00:00:00Z' },
    ] })),
    markRead: vi.fn(async () => ({ changed: 0 })),
  },
}));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: [{ address: 'owner@example.com' }] }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => ({ id: 1, role: 'user' }) }));
vi.mock('./download', () => ({ downloadWithAuth: mocks.download, openOrDownloadWithAuth: vi.fn() }));
// 第 1 封的 HTML 让正文渲染抛错（模拟畸形邮件让消毒或 iframe 写入失败）
vi.mock('@/lib/email-html', () => ({
  EmailHtml: ({ html }: { html: string }) => {
    if (html.includes('broken')) throw new Error('sanitize exploded');
    return <div data-testid="email-html">{html}</div>;
  },
}));
import { MessagePage } from './message-page';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.download.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('MessagePage 正文降级', () => {
  it('正文渲染失败只降级正文区：页头操作照常，显示纯文本并可下载 .eml；换一封邮件恢复正常渲染', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/mail/1']}>
          <Routes>
            <Route path="/mail/:id" element={<MessagePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'mail-1' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('正文无法按原格式显示');
    expect(screen.getByText('纯文本版本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '回复' })).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: '下载原始邮件 (.eml)' }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith('/api/messages/1/raw', 'message-1.eml', expect.anything()));

    fireEvent.click(screen.getByRole('link', { name: /thread-2/ }));
    expect(await screen.findByTestId('email-html')).toHaveTextContent('<p>fine</p>');
    expect(screen.queryByText('正文无法按原格式显示，已改为纯文本。')).toBeNull();
    client.clear();
  });
});
