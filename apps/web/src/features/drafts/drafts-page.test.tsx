import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Draft, DraftSummary, MessageSummary, Page } from '@hpc-mail/shared';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('./drafts-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drafts-api')>()),
  draftsApi: { list: mocks.list, get: mocks.get, send: mocks.send, update: mocks.update, remove: mocks.remove },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({
  useMailboxesQuery: () => ({ data: [{ id: 9, address: 'me@one.example' }] }),
}));

import { DraftsPage } from './drafts-page';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 5, status: 'draft', version: 3, from: { mailboxId: 9 }, to: [{ address: 'bob@example.net', name: 'Bob' }], cc: [], bcc: [],
    subject: '合同确认', preview: '请确认附件', attachmentCount: 0, sendAt: null, messageId: null, errorDetail: '',
    createdVia: 'api', apiKeyName: '报销 Agent', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', sentAt: null,
    replyTo: [], text: '', html: '<p>请确认附件</p>', headers: {}, replyToMessageId: null, forwardAttachmentsFrom: null, attachments: [],
    ...overrides,
  };
}
const summary = (value: Draft): DraftSummary => {
  const { replyTo: _r, text: _t, html: _h, headers: _hd, replyToMessageId: _m, forwardAttachmentsFrom: _f, attachments: _a, ...rest } = value;
  return rest;
};
const page = (items: DraftSummary[], nextCursor: string | null = null): Page<DraftSummary> => ({ items, nextCursor });
const sent: MessageSummary = { id: 88, status: 'sent', errorDetail: '', recipientOutcomes: [] } as unknown as MessageSummary;

function show(path = '/drafts') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: '/drafts', element: <DraftsPage /> },
    { path: '/compose', element: <p>compose page</p> },
    { path: '/mail/:id', element: <p>mail page</p> },
  ], { initialEntries: [path] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('草稿箱列表', () => {
  it('显示主题、收件人、发件地址、状态（含定时时间、失败原因、发件记录链接）与来源', async () => {
    mocks.list.mockResolvedValue(page([
      summary(draft({ id: 7, status: 'scheduled', sendAt: '2026-11-18T01:00:00Z', attachmentCount: 2 })),
      summary(draft({ id: 6, status: 'failed', errorDetail: 'bob@example.net: 550 mailbox unavailable', createdVia: 'web', apiKeyName: null, subject: '' })),
      summary(draft({ id: 5, status: 'sent', messageId: 77, from: { localPart: 'sales', domain: 'two.example', displayName: '销售部' }, apiKeyName: null })),
    ]));
    show();
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('合同确认')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('发给 Bob')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/^定时于 2026-11-18/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('API · 报销 Agent')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('从 me@one.example')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2 个附件')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('（无主题）')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('发送失败')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('网页')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('失败原因：bob@example.net: 550 mailbox unavailable')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('已发送')).toBeInTheDocument();
    // Key 已删除时只标 API
    expect(within(rows[2]!).getByText('API')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('从 销售部 <sales@two.example>')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('link', { name: '查看发件记录' })).toHaveAttribute('href', '/mail/77');
    expect(mocks.list).toHaveBeenCalledWith({ status: undefined, cursor: undefined }, expect.anything());
  });

  it('按状态筛选（写进地址栏）并按游标加载更多', async () => {
    const user = userEvent.setup();
    mocks.list.mockImplementation(async (query: { status?: string; cursor?: string }) => query.cursor
      ? page([summary(draft({ id: 2, subject: '更早的草稿', status: 'scheduled', sendAt: '2026-11-19T00:00:00Z' }))])
      : page([summary(draft({ id: 9, status: 'scheduled', sendAt: '2026-11-18T00:00:00Z' }))], 'cursor-9'));
    const { router } = show();
    await screen.findByText('合同确认');
    await user.click(screen.getByRole('radio', { name: '定时' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ status: 'scheduled', cursor: undefined }, expect.anything()));
    expect(router.state.location.search).toBe('?status=scheduled');
    await user.click(await screen.findByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('更早的草稿')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({ status: 'scheduled', cursor: 'cursor-9' }, expect.anything());
  });
});

describe('审阅与发送（人审后再发）', () => {
  it('审阅显示完整内容，HTML 正文进沙箱 iframe 而不注入页面；确认对话框写明从哪发给谁，确认后带审阅的版本发送并就地更新列表', async () => {
    const user = userEvent.setup();
    const detail = draft({
      cc: [{ address: 'carol@example.net', name: '' }],
      html: '<p>请确认<img src="x" onerror="window.__pwned=1"></p><script>window.__pwned=1</script>',
      text: '请确认（纯文本）',
      attachments: [{ token: 'tok', filename: 'contract.pdf', mimeType: 'application/pdf', size: 2048, contentId: '', disposition: 'attachment' }],
    });
    mocks.list.mockResolvedValue(page([summary(detail)]));
    mocks.get.mockResolvedValue(detail);
    mocks.send.mockResolvedValue(sent);
    show();
    await user.click(await screen.findByRole('button', { name: '审阅' }));
    const review = await screen.findByRole('dialog');
    expect(await within(review).findByText('Bob <bob@example.net>')).toBeInTheDocument();
    expect(within(review).getByText('carol@example.net')).toBeInTheDocument();
    expect(within(review).getByText('contract.pdf')).toBeInTheDocument();
    // 主文档里没有草稿的脚本与图片；HTML 源码以文本形式折叠展示
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(within(review).getByText(/<script>window.__pwned=1<\/script>/)).toBeInTheDocument();
    expect(review.querySelector('iframe')).not.toBeNull();

    await user.click(within(review).getByRole('button', { name: '发送…' }));
    const confirm = await screen.findByRole('dialog', { name: '确认发送这封邮件？' });
    expect(within(confirm).getByText('me@one.example')).toBeInTheDocument();
    expect(within(confirm).getByText('Bob <bob@example.net>')).toBeInTheDocument();
    expect(within(confirm).getByText(/由 API · 报销 Agent 创建/)).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith(5, 3));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '邮件已提交发送', variant: 'success' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = screen.getByRole('listitem');
    expect(await within(row).findByText('已发送')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '查看发件记录' })).toHaveAttribute('href', '/mail/88');
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('审阅后草稿又被改过：409 不发出，提示并载入最新内容，审阅保持打开', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue(page([summary(draft())]));
    mocks.get.mockResolvedValueOnce(draft()).mockResolvedValue(draft({ version: 4, subject: 'Agent 改过的主题' }));
    mocks.send.mockRejectedValue(new ApiError('草稿已被修改（当前版本 4）', { code: 'draft_state_conflict', httpStatus: 409, details: { draftStatus: 'draft', draftVersion: 4 } }));
    show();
    await user.click(await screen.findByRole('button', { name: '审阅' }));
    await user.click(await screen.findByRole('button', { name: '发送…' }));
    await user.click(within(await screen.findByRole('dialog', { name: '确认发送这封邮件？' })).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '草稿已被修改，没有发送', variant: 'error' })));
    expect(await screen.findByRole('dialog', { name: 'Agent 改过的主题' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '确认发送这封邮件？' })).toBeNull();
  });

  it('422 全部拒收：提示逐收件人原因，列表读回 failed 状态', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue(page([summary(draft())]));
    mocks.get.mockResolvedValue(draft({ status: 'failed', version: 5, messageId: 90, errorDetail: 'bob@example.net: 550' }));
    mocks.send.mockRejectedValue(new ApiError('全部收件人发送失败', {
      code: 'delivery_failed', httpStatus: 422,
      details: { messageId: 90, recipientOutcomes: [{ address: 'bob@example.net', status: 'failed', error: '550' }] },
    }));
    show();
    await screen.findByText('合同确认');
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '发送…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '发送失败：所有收件人都没有收到', description: 'bob@example.net：550', variant: 'error',
    })));
    expect(await screen.findByText('失败原因：bob@example.net: 550')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看失败记录' })).toHaveAttribute('href', '/mail/90');
  });
});

describe('取消定时、删除与编辑', () => {
  it('取消定时：PATCH {sendAt:null}，列表就地变回草稿', async () => {
    const user = userEvent.setup();
    const scheduled = draft({ status: 'scheduled', sendAt: '2026-11-18T01:00:00Z' });
    mocks.list.mockResolvedValue(page([summary(scheduled)]));
    mocks.update.mockResolvedValue(draft({ version: 4 }));
    show();
    await screen.findByText(/^定时于/);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '取消定时' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(5, { sendAt: null }));
    await waitFor(() => expect(screen.queryByText(/^定时于/)).toBeNull());
    expect(within(screen.getByRole('listitem')).getByText('草稿')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('删除要确认，删除后从列表移除', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue(page([summary(draft()), summary(draft({ id: 4, subject: '另一份' }))]));
    mocks.remove.mockResolvedValue({ success: true });
    show();
    await screen.findByText('合同确认');
    await user.click(screen.getAllByRole('button', { name: '更多操作' })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: '删除这份草稿？' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(5));
    await waitFor(() => expect(screen.queryByText('合同确认')).toBeNull());
    expect(screen.getByText('另一份')).toBeInTheDocument();
  });

  it('编辑打开写信页并带上草稿 id', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue(page([summary(draft())]));
    const { router } = show();
    await screen.findByText('合同确认');
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '编辑' }));
    expect(await screen.findByText('compose page')).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ serverDraftId: 5 });
  });
});
