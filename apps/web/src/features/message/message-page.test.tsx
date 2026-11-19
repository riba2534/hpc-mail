import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
const mocks = vi.hoisted(() => ({
  markRead: vi.fn(async (_ids:number[],_isRead:boolean,_scope?:string) => ({changed:1})),
  remove: vi.fn(async (ids:number[]) => ({deleted: ids.length})),
  restore: vi.fn(async (ids:number[]) => ({changed: ids.length})),
  toast: vi.fn(),
  owned: [{ address: 'owner@example.com' }],
  overrides: {} as Record<number, Partial<MessageDetail>>,
}));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: false, isStarred: false,
      fromAddress: `sender${id}@outside.com`, fromName: '', subject: `mail-${id}`,
      bodyHtml: '<img src="https://outside.com/pixel">', bodyText: 'hello', verificationCode: '', verificationLink: '',
      recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: false, createdAt: '2026-10-01T00:00:00Z',
      ...mocks.overrides[id],
    })),
    thread: vi.fn(async () => ({ items: [
      { id: 1, subject: 'thread-1', fromAddress: 'sender1@outside.com', createdAt: '2026-10-01T00:00:00Z' },
      { id: 2, subject: 'thread-2', fromAddress: 'sender2@outside.com', createdAt: '2026-10-01T00:00:00Z' },
    ] })),
    markRead: mocks.markRead,
    remove: mocks.remove,
    restore: mocks.restore,
  },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: mocks.owned }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/email-html', () => ({ EmailHtml: ({allowRemoteImages}: {allowRemoteImages: boolean}) => <div data-testid="email-html" data-allow={String(allowRemoteImages)} /> }));
vi.mock('@/lib/use-session', () => ({useCurrentUser: () => ({id:1,role:'user'})}));
import { messageApi } from '@/api/resources';
import { MessagePage } from './message-page';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function show(entry: string | { pathname: string; state?: unknown } = '/mail/1', client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/inbox', entry]} initialIndex={1}>
        <Routes>
          <Route path="/mail/:id" element={<><MessagePage /><Where /></>} />
          <Route path="/inbox" element={<p>inbox list</p>} />
          <Route path="/compose" element={<p>compose page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  localStorage.clear();
  mocks.markRead.mockClear();
  mocks.remove.mockClear();
  mocks.restore.mockClear();
  mocks.toast.mockClear();
  mocks.owned = [{ address: 'owner@example.com' }];
  mocks.overrides = {};
});

describe('MessagePage navigation', () => {
  it('marks each message read and binds remote image permission to one mail', async () => {
    const client = show();
    await screen.findByText('mail-1');
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith([1], true, undefined, true));
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

  it('tells the user when marking the opened mail read fails, keeping the server reason and request id', async () => {
    const { ApiError } = await import('@/api/errors');
    // 失败提示来自应用的全局 mutationCache
    const { queryClient } = await import('@/lib/query-client');
    mocks.markRead.mockRejectedValueOnce(new ApiError('操作过于频繁', { code: 'rate_limited', httpStatus: 429, requestId: 'req-9' }));
    const client = show('/mail/1', queryClient);
    await screen.findByText('mail-1');
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({
      title: '已读状态更新失败', description: '操作过于频繁', requestId: 'req-9', variant: 'error',
    }));
    expect(mocks.toast).toHaveBeenCalledOnce();
    client.clear();
  });

  it('steps through the originating list with j/k and the arrow buttons', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const list = { direction: 'inbound' as const, scope: 'mine' as const, unread: true };
    client.setQueryData(queryKeys.messages.list(list), { pages: [{ items: [{ id: 3 }, { id: 1 }, { id: 2 }], nextCursor: null }], pageParams: [''] });
    show({ pathname: '/mail/1', state: { list } }, client);
    await screen.findByText('mail-1');
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j' });
    await screen.findByText('mail-2');
    expect(screen.getByRole('button', { name: '下一封' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'k' });
    await screen.findByText('mail-1');
    fireEvent.click(screen.getByRole('button', { name: '上一封' }));
    await screen.findByText('mail-3');
    client.clear();
  });

  it('prefetches the neighbour only after j/k, and only in that direction', async () => {
    const detail = vi.mocked(messageApi.detail);
    detail.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const list = { direction: 'inbound' as const, scope: 'mine' as const };
    client.setQueryData(queryKeys.messages.list(list), { pages: [{ items: [{ id: 3 }, { id: 1 }, { id: 2 }, { id: 4 }], nextCursor: null }], pageParams: [''] });
    show({ pathname: '/mail/1', state: { list } }, client);
    await screen.findByText('mail-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 直接打开：不预取上一封/下一封
    expect(detail.mock.calls.map(([id]) => id)).toEqual([1]);
    fireEvent.click(screen.getByRole('button', { name: '下一封' }));
    await screen.findByText('mail-2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 按钮切换也不预取
    expect(detail.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    fireEvent.keyDown(window, { key: 'k' });
    await screen.findByText('mail-1');
    // k 之后只预取同方向（上一封）的那一封
    await waitFor(() => expect(detail.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]));
    fireEvent.keyDown(window, { key: 'j' });
    await screen.findByText('mail-2');
    await waitFor(() => expect(detail.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4]));
    client.clear();
  });

  it('writes the unread count returned by /read instead of refetching it', async () => {
    mocks.markRead.mockResolvedValueOnce({ changed: 1, unread: 4 } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 5 });
    show('/mail/1', client);
    await screen.findByText('mail-1');
    await waitFor(() => expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 4 }));
    expect(client.getQueryState(queryKeys.messages.unreadCount)?.isInvalidated).toBe(false);
    client.clear();
  });

  it('falls back to refetching the unread count when /read does not return it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.messages.unreadCount, { unread: 5 });
    show('/mail/1', client);
    await screen.findByText('mail-1');
    await waitFor(() => expect(client.getQueryState(queryKeys.messages.unreadCount)?.isInvalidated).toBe(true));
    client.clear();
  });

  it('keyboard r opens a reply and Escape returns to the list', async () => {
    const first = show();
    await screen.findByText('mail-1');
    fireEvent.keyDown(window, { key: 'r' });
    await screen.findByText('compose page');
    first.clear();
    cleanup();
    const second = show();
    await screen.findByText('mail-1');
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText('inbox list');
    second.clear();
  });
});

describe('MessagePage shared and destructive actions', () => {
  it('a shared mail is read-only: not marked read, no unread/delete/reply actions', async () => {
    mocks.owned = [{ address: 'someone-else@example.com' }];
    const client = show();
    await screen.findByText('mail-1');
    expect(screen.getByText('共享 · 只读')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '标为未读' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除邮件' })).toBeNull();
    expect(screen.queryByRole('button', { name: /回复/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'U', shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.markRead).not.toHaveBeenCalled();
    client.clear();
  });

  it('deletes without a confirm dialog and offers undo', async () => {
    const client = show();
    await screen.findByText('mail-1');
    fireEvent.click(screen.getByRole('button', { name: '删除邮件' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith([1], undefined));
    await screen.findByText('inbox list');
    const deleted = mocks.toast.mock.calls.map(([input]) => input).find((input) => input.action);
    expect(deleted).toMatchObject({ action: { label: '撤销' }, duration: 5000 });
    await act(async () => deleted.action.onClick());
    expect(mocks.restore).toHaveBeenCalledWith([1], undefined);
    client.clear();
  });
});

describe('MessagePage toolbar on small screens', () => {
  it('collects secondary actions in the More menu so the bar stays on one line', async () => {
    mocks.overrides[1] = { hasRaw: true, isRead: true };
    const client = show();
    await screen.findByText('mail-1');
    const toolbar = screen.getByRole('button', { name: '返回列表' }).parentElement!;
    expect(toolbar.className).toContain('flex-nowrap');
    expect(screen.getByRole('button', { name: '标为未读' })).toHaveClass('hidden', 'sm:inline-grid');
    expect(screen.getByRole('button', { name: '下载原始邮件 (.eml)' })).toHaveClass('hidden', 'sm:inline-grid');
    const more = screen.getByRole('button', { name: '更多操作' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: '标为未读' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '下载原始邮件 (.eml)' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '转发' })).toBeInTheDocument();
    client.clear();
  });
});

describe('MessagePage content', () => {
  it('separates To and Cc, de-duplicated', async () => {
    mocks.overrides[1] = { recipients: { to: ['owner@example.com', 'Owner@example.com', 'b@x.com'], cc: ['b@x.com', 'c@x.com'], bcc: [] } };
    const client = show();
    await screen.findByText('mail-1');
    expect(screen.getByText('owner@example.com、b@x.com')).toBeInTheDocument();
    expect(screen.getByText('c@x.com')).toBeInTheDocument();
    expect(screen.getByText(/抄送/)).toBeInTheDocument();
    client.clear();
  });

  it('linkifies plain-text bodies', async () => {
    mocks.overrides[1] = { bodyHtml: '', bodyText: '点击 https://example.com/confirm?t=1 完成验证' };
    const client = show();
    const link = await screen.findByRole('link', { name: 'https://example.com/confirm?t=1' });
    expect(link).toHaveAttribute('target', '_blank');
    client.clear();
  });

  it('only copies an opaque verification link after explicit confirmation', async () => {
    const tracked = 'https://mail.example.test/ls/click?token=private';
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
    mocks.overrides[1] = { verificationLink: tracked, bodyHtml: '', bodyText: tracked };
    const client = show();
    try {
      fireEvent.click(await screen.findByRole('button', { name: '复制原始验证链接' }));
      expect(screen.getByText(/记录本次点击/)).toBeInTheDocument();
      expect(writeText).not.toHaveBeenCalled();
      expect(document.body.innerHTML).not.toContain(tracked);
      fireEvent.click(screen.getByRole('button', { name: '继续复制' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(tracked));
    } finally {
      if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
      client.clear();
    }
  });

  it('shows a verification link on another domain without any mismatch warning', async () => {
    mocks.overrides[1] = { fromAddress: 'security@bank.example', verificationLink: 'https://bank-example.verify.io/confirm' };
    const client = show();
    const open = await screen.findByRole('link', { name: '打开验证链接' });
    expect(open).toHaveAttribute('href', 'https://bank-example.verify.io/confirm');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('bank-example.verify.io')).toBeInTheDocument();
    expect(screen.queryByText(/不一致/)).toBeNull();
    client.clear();
  });
});
