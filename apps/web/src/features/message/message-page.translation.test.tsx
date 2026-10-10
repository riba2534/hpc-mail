import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toast: vi.fn(),
  config: { translationEnabled: true } as { translationEnabled: boolean } | undefined,
  owned: [{ address: 'owner@example.com' }],
  overrides: {} as Partial<MessageDetail>,
}));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: true, isStarred: false,
      fromAddress: 'news@outside.com', fromName: '', subject: 'Your order has shipped',
      bodyHtml: '', bodyText: 'Hello Alice,\n\nYour package is on the way.\n\n> quoted reply',
      verificationCode: '', verificationLink: '', recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: false, createdAt: '2026-10-01T00:00:00Z',
      ...mocks.overrides,
    })),
    thread: vi.fn(async () => ({ items: [] })),
    markRead: vi.fn(async () => ({ changed: 0 })),
  },
}));
vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));
vi.mock('@/lib/use-config', () => ({ usePublicConfig: () => ({ data: mocks.config }) }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: mocks.owned }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => ({ id: 1, role: 'admin' }) }));
// 用普通 div 代替 iframe：与真组件一样，每次重新渲染换一个新的正文根节点并回调
vi.mock('@/lib/email-html', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    EmailHtml: ({ html, allowRemoteImages, onContentChange }: { html: string; allowRemoteImages: boolean; onContentChange?: (el: HTMLElement | null) => void }) => {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const content = document.createElement('div');
        content.innerHTML = html;
        ref.current!.replaceChildren(content);
        onContentChange?.(content);
        return () => onContentChange?.(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [html, allowRemoteImages]);
      return <div data-testid="email-html" ref={ref} />;
    },
  };
});

import { MessagePage } from './message-page';

const translateEcho = async (_path: string, body: { segments: string[] }) => ({
  translations: body.segments.map((segment) => `译:${segment}`),
  cached: false,
  skipped: 0,
});

function show(entry = '/mail/1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/inbox', entry]} initialIndex={1}>
        <Routes>
          <Route path="/mail/:id" element={<MessagePage />} />
          <Route path="/inbox" element={<p>inbox list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const translateButton = () => screen.queryByRole('button', { name: '翻译' });

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockImplementation(translateEcho);
  mocks.toast.mockClear();
  mocks.config = { translationEnabled: true };
  mocks.owned = [{ address: 'owner@example.com' }];
  mocks.overrides = {};
});

describe('翻译按钮显示条件', () => {
  it('站点启用且正文主要不是中文时显示，小屏收进「更多」', async () => {
    const client = show();
    await screen.findByText('Your order has shipped');
    expect(translateButton()).toHaveClass('hidden', 'sm:inline-flex');
    fireEvent.pointerDown(screen.getByRole('button', { name: '更多操作' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: '翻译' })).toBeInTheDocument();
    client.clear();
  });

  it.each([
    ['站点未启用', () => void (mocks.config = { translationEnabled: false })],
    ['正文主要是中文', () => void (mocks.overrides = { bodyText: '您好，您的包裹已经发出，预计三天内送达。Tracking: SF123' })],
    ['正文为空', () => void (mocks.overrides = { bodyText: '' })],
  ])('%s时不显示，t 键也不触发', async (_label, arrange) => {
    arrange();
    const client = show();
    await screen.findByText('Your order has shipped');
    expect(translateButton()).toBeNull();
    fireEvent.keyDown(window, { key: 't' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.post).not.toHaveBeenCalled();
    client.clear();
  });
});

describe('纯文本邮件翻译', () => {
  it('主题与段落一起翻译，引用块不翻；切换原文与 t 键不重复请求', async () => {
    const client = show();
    await screen.findByText('Your order has shipped');
    fireEvent.click(translateButton()!);

    expect(await screen.findByText('译:Your order has shipped')).toBeInTheDocument();
    expect(screen.getByText('原文：Your order has shipped')).toBeInTheDocument();
    expect(screen.getByText(/译:Hello Alice,/)).toBeInTheDocument();
    expect(screen.getByText(/译:Your package is on the way\./)).toBeInTheDocument();
    expect(screen.getByText('AI 翻译 · 仅供参考')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      '/messages/1/translate',
      { segments: ['Your order has shipped', 'Hello Alice,', 'Your package is on the way.'] },
      expect.objectContaining({ query: { scope: undefined, userId: undefined } }),
    );

    fireEvent.click(screen.getByRole('button', { name: '显示原文' }));
    expect(screen.getByRole('heading', { name: 'Your order has shipped' })).toBeInTheDocument();
    expect(screen.queryByText(/译:Hello Alice/)).toBeNull();
    expect(screen.queryByText('AI 翻译 · 仅供参考')).toBeNull();

    fireEvent.keyDown(window, { key: 't' });
    expect(await screen.findByText(/译:Hello Alice,/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 't' });
    await waitFor(() => expect(screen.queryByText(/译:Hello Alice/)).toBeNull());
    expect(mocks.post).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('失败时显示原因与重试，重试成功后显示译文', async () => {
    mocks.post.mockRejectedValueOnce(new ApiError('今日翻译额度已用完', { code: 'rate_limited', httpStatus: 429 }));
    const client = show();
    await screen.findByText('Your order has shipped');
    fireEvent.click(translateButton()!);
    expect(await screen.findByText('1 批翻译失败：今日翻译额度已用完')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText(/译:Hello Alice,/)).toBeInTheDocument();
    expect(screen.queryByText(/批翻译失败/)).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    client.clear();
  });
});

describe('HTML 邮件翻译', () => {
  it('原位替换文字节点，重新渲染后套用已有译文，切回原文复原', async () => {
    mocks.overrides = {
      bodyHtml: '<p>Hello <b>world</b></p><pre>npm install</pre><img src="https://outside.com/a.png">',
      bodyText: '',
    };
    const client = show();
    await screen.findByText('Your order has shipped');
    const body = () => screen.getByTestId('email-html');
    fireEvent.click(translateButton()!);
    await waitFor(() => expect(body()).toHaveTextContent('译:Hello 译:world'));
    expect(body()).toHaveTextContent('npm install');
    expect(mocks.post.mock.calls[0]![1]).toEqual({ segments: ['Your order has shipped', 'Hello', 'world'] });

    // 显示图片 → 正文重新渲染出新节点
    fireEvent.click(screen.getByRole('button', { name: '显示图片' }));
    await waitFor(() => expect(body()).toHaveTextContent('译:Hello 译:world'));
    expect(mocks.post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '显示原文' }));
    await waitFor(() => expect(body()).toHaveTextContent(/^Hello worldnpm install$/));
    client.clear();
  });
});

describe('只读视图', () => {
  it('共享邮件可以翻译', async () => {
    mocks.owned = [{ address: 'someone-else@example.com' }];
    const client = show();
    await screen.findByText('共享 · 只读');
    fireEvent.click(translateButton()!);
    expect(await screen.findByText(/译:Hello Alice,/)).toBeInTheDocument();
    client.clear();
  });

  it('管理员未认领视图按当前 scope 请求', async () => {
    const client = show('/mail/1?scope=unclaimed');
    await screen.findByText('Your order has shipped');
    fireEvent.keyDown(window, { key: 't' });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      '/messages/1/translate',
      expect.anything(),
      expect.objectContaining({ query: { scope: 'unclaimed', userId: undefined } }),
    ));
    client.clear();
  });
});
