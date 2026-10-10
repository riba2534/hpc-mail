import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owned: undefined as unknown[] | undefined,
  shared: undefined as unknown[] | undefined,
  listEmpty: false,
}));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({ data: state.owned, isError: false, refetch: vi.fn() }),
  useSharedMailboxesQuery: () => ({ data: state.shared, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: undefined }) }));
vi.mock('./use-unread-count', () => ({ useUnreadCount: () => ({ data: { unread: 0 } }) }));
vi.mock('./mail-list', () => ({
  MailList: ({ emptyContent }: { emptyContent?: ReactNode }) =>
    state.listEmpty ? <div data-testid="empty">{emptyContent ?? '还没有邮件'}</div> : <div data-testid="list">rows</div>,
}));
import { InboxPage } from './inbox-page';

function renderPage() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  state.owned = undefined;
  state.shared = undefined;
  state.listEmpty = false;
});

describe('InboxPage 先挂载列表', () => {
  it('地址列表未返回时邮件列表已经渲染', () => {
    const { client } = renderPage();
    expect(screen.getByTestId('list')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '已读状态' })).toBeInTheDocument();
    client.clear();
  });

  it('列表为空且地址未就绪时占位，不提前判定未认领', () => {
    state.listEmpty = true;
    const { container, client } = renderPage();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('你还没有认领任何邮箱地址')).toBeNull();
    client.clear();
  });

  it('两个地址列表都为空且没有邮件时引导认领', () => {
    state.owned = [];
    state.shared = [];
    state.listEmpty = true;
    const { client } = renderPage();
    expect(screen.getByText('你还没有认领任何邮箱地址')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '已读状态' })).toBeNull();
    client.clear();
  });

  it('有地址时空列表沿用默认空态', () => {
    state.owned = [{ id: 1, address: 'me@example.com', domain: 'example.com', displayName: '' }];
    state.shared = [];
    state.listEmpty = true;
    const { client } = renderPage();
    expect(screen.getByTestId('empty')).toHaveTextContent('还没有邮件');
    client.clear();
  });
});
