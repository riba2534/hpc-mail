import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ markRead: vi.fn(async (_ids:number[],_isRead:boolean,_scope?:string) => ({changed:1})), allowRemote: false }));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: false, isStarred: false,
      fromAddress: `sender${id}@outside.com`, fromName: '', subject: `mail-${id}`,
      bodyHtml: '<img src="https://outside.com/pixel">', bodyText: 'hello',
      recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: false, createdAt: '2026-10-01T00:00:00Z',
    })),
    thread: vi.fn(async () => ({ items: [
      { id: 1, subject: 'thread-1', fromAddress: 'sender1@outside.com', createdAt: '2026-10-01T00:00:00Z' },
      { id: 2, subject: 'thread-2', fromAddress: 'sender2@outside.com', createdAt: '2026-10-01T00:00:00Z' },
    ] })),
    markRead: mocks.markRead,
  },
}));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useSharedMailboxesQuery: () => ({ data: [], isPending: false }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/email-html', () => ({ EmailHtml: ({allowRemoteImages}: {allowRemoteImages: boolean}) => <div data-testid="email-html" data-allow={String(allowRemoteImages)} /> }));
vi.mock('@/lib/use-session', () => ({useCurrentUser: () => ({id:1,role:'user'})}));
import { MessagePage } from './message-page';

describe('MessagePage navigation', () => {
  it('marks each message read and binds remote image permission to one mail', async () => {
    localStorage.clear();
    mocks.markRead.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/mail/1']}><Routes><Route path="/mail/:id" element={<MessagePage />} /></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByText('mail-1');
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith([1], true, undefined));
    expect(screen.getByTestId('email-html')).toHaveAttribute('data-allow', 'false');
    fireEvent.click(screen.getByRole('button', { name: '显示图片' }));
    expect(screen.getByTestId('email-html')).toHaveAttribute('data-allow', 'true');
    fireEvent.click(screen.getByRole('link', { name: /thread-2/ }));
    await screen.findByText('mail-2');
    expect(screen.getByTestId('email-html')).toHaveAttribute('data-allow', 'false');
    expect(screen.getByRole('button', { name: '显示图片' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.markRead.mock.calls.map((args) => args[0])).toEqual([[1], [2]]));
    client.clear();
  });
});
