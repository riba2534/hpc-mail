import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '@hpc-mail/shared';

const SIGNED_URL = '/api/attachments/9?exp=1700000000&sig=old';
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  overrides: [] as Array<Partial<MessageDetail>>,
}));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: true, isStarred: false,
      fromAddress: 'sender@outside.com', fromName: '', subject: `mail-${id}`,
      bodyHtml: `<p>logo<img src="${location.origin}/api/attachments/8?exp=1700000000&amp;sig=cid"></p>`,
      bodyText: 'hello', verificationCode: '', verificationLink: '',
      recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [
        { id: 9, filename: '报告.zip', mimeType: 'application/zip', size: 2048, contentId: '', disposition: 'attachment', url: SIGNED_URL },
        { id: 10, filename: '截图.png', mimeType: 'image/png', size: 4096, contentId: '', disposition: 'attachment', url: '/api/attachments/10?exp=1700000000&sig=old' },
      ],
      hasRaw: false, createdAt: '2026-10-01T00:00:00Z',
      ...mocks.overrides.shift(),
    })),
    thread: vi.fn(async () => ({ items: [] })),
    markRead: vi.fn(async () => ({ changed: 0 })),
  },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: [{ address: 'owner@example.com' }] }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => ({ id: 1, role: 'admin' }) }));
import { messageApi } from '@/api/resources';
import { MessagePage } from './message-page';

const fetchMock = vi.fn<typeof fetch>();
const clicked: Array<{ href: string; download: string }> = [];

function show(entry = '/mail/1') {
  // 与 lib/query-client 一致：全局关闭聚焦刷新，详情页需自己开启
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/mail/:id" element={<MessagePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const attachmentButton = () => screen.findByRole('button', { name: /报告\.zip/ });
const imageButton = () => screen.findByRole('button', { name: /截图\.png/ });

function fakeTab() {
  return { location: { href: '' }, close: vi.fn(), closed: false, opener: window } as unknown as Window & { close: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'session-jwt');
  mocks.toast.mockClear();
  mocks.overrides = [];
  vi.mocked(messageApi.detail).mockClear();
  clicked.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Blob(['%PDF']), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:attachment');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MessagePage attachment download', () => {
  it('downloads with the session token long after the old 5-minute signature would have expired', async () => {
    const client = show();
    const button = await attachmentButton();
    // 不再渲染指向签名 URL 的链接
    expect(document.querySelector(`a[href="${SIGNED_URL}"]`)).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    fireEvent.click(button);
    await waitFor(() => expect(clicked).toEqual([{ href: 'blob:attachment', download: '报告.zip' }]));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/attachments/9');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-jwt');
    expect(mocks.toast).not.toHaveBeenCalled();
    client.clear();
  });

  it('carries the admin audit view so the JWT route resolves the same visibility as the detail', async () => {
    const client = show('/mail/1?scope=user&userId=7');
    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/9?scope=user&userId=7');
    client.clear();
  });

  it('explains why a download failed instead of showing raw JSON', async () => {
    const client = show();
    const button = await attachmentButton();

    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'not_found', message: '附件不存在' }, requestId: 'r1' }, { status: 404 }));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith({ title: '附件下载失败', description: '附件不存在', variant: 'error' }));

    fetchMock.mockResolvedValueOnce(new Response('gateway', { status: 401 }));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: '登录已过期，请重新登录后再下载' })));

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: '网络连接失败，请检查网络后重试' })));
    expect(clicked).toEqual([]);
    client.clear();
  });
});

describe('MessagePage attachment preview', () => {
  it('opens an image in a tab opened during the click, then points it at a typed blob URL', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    let respond!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
    const client = show();
    fireEvent.click(await imageButton());
    // 在点击的同步阶段打开，fetch 还没返回：等返回后再 window.open 会被浏览器当作弹窗拦截
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    respond(new Response(new Blob(['png-bytes'], { type: 'application/octet-stream' }), { status: 200 }));
    await waitFor(() => expect(tab.location.href).toBe('blob:attachment'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/10');
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]![0]).toMatchObject({ type: 'image/png' });
    expect(tab.opener).toBeNull();
    expect(clicked).toEqual([]);
    client.clear();
  });

  it('falls back to downloading when the browser blocks the new tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const client = show();
    fireEvent.click(await imageButton());
    await waitFor(() => expect(clicked).toEqual([{ href: 'blob:attachment', download: '截图.png' }]));
    client.clear();
  });

  it('closes the pre-opened tab and explains the failure when the fetch fails', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'not_found', message: '附件不存在' } }, { status: 404 }));
    const client = show();
    fireEvent.click(await imageButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '附件下载失败', description: '附件不存在', variant: 'error' }));
    expect(tab.close).toHaveBeenCalled();
    client.clear();
  });

  it('downloads other types without opening a tab', async () => {
    const open = vi.spyOn(window, 'open');
    const client = show();
    fireEvent.click(await attachmentButton());
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(open).not.toHaveBeenCalled();
    client.clear();
  });

  it('downloads PDFs and images with a spliced HTML type under their original names, never in a tab', async () => {
    mocks.overrides.push({ attachments: [
      { id: 11, filename: '合同.pdf', mimeType: 'application/pdf', size: 10, contentId: '', disposition: 'attachment', url: '' },
      { id: 12, filename: 'x.png', mimeType: 'image/png,text/html', size: 10, contentId: '', disposition: 'attachment', url: '' },
    ] });
    const open = vi.spyOn(window, 'open');
    const client = show();
    fireEvent.click(await screen.findByRole('button', { name: /合同\.pdf/ }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /x\.png/ }));
    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked.map((item) => item.download)).toEqual(['合同.pdf', 'x.png']);
    expect(open).not.toHaveBeenCalled();
    client.clear();
  });

  it('leaving the page aborts an in-flight attachment: no toast, no download, the opened tab is closed', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = show();
    fireEvent.click(await imageButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    cleanup();
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
    expect(tab.location.href).toBe('');
    client.clear();
  });
});

describe('MessagePage detail freshness', () => {
  afterEach(() => act(() => focusManager.setFocused(undefined)));

  it('refetches a stale detail on window focus without rebuilding an unchanged body', async () => {
    const client = show();
    await attachmentButton();
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="邮件正文"]')!;
    await waitFor(() => expect(iframe.contentDocument?.getElementById('email-content')).not.toBeNull());
    const body = iframe.contentDocument!.getElementById('email-content');
    expect(messageApi.detail).toHaveBeenCalledTimes(1);

    // 同一小时内重拉：签名不变，正文字符串完全相同（星标等其他字段可能变化）
    mocks.overrides.push({ isStarred: true });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(messageApi.detail).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: '取消星标' });
    expect(iframe.contentDocument!.getElementById('email-content')).toBe(body);
    client.clear();
  });
});
