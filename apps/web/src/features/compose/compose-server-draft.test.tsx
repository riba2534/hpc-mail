import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Draft, MessageSummary } from '@hpc-mail/shared';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({
  user: { id: 1, role: 'user' },
  boxes: [{ id: 9, address: 'first@one.example' }, { id: 10, address: 'second@two.example' }],
  get: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  draftSend: vi.fn(),
  messageSend: vi.fn(),
  remove: vi.fn(async () => ({ success: true })),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({
  messageApi: { contacts: vi.fn(async () => ({ contacts: [] })), send: mocks.messageSend },
  uploadsApi: { single: vi.fn(), remove: mocks.remove },
}));
vi.mock('@/features/drafts/drafts-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/drafts/drafts-api')>()),
  draftsApi: { get: mocks.get, update: mocks.update, create: mocks.create, send: mocks.draftSend },
}));
vi.mock('@/lib/use-config', () => ({ useDomains: () => ({ data: ['one.example', 'two.example'] }) }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: mocks.boxes }) }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));

import { ComposePage } from './compose-page';
import type { ComposeInitial } from './compose-init';
import { draftKeyForUser } from './compose-draft';
import { sendAttemptKeyForUser } from './send-attempt';
import { toLocalInputValue } from './schedule-time';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 5, status: 'scheduled', version: 3, from: { mailboxId: 10, displayName: '报销助手' },
    to: [{ address: 'bob@example.net', name: 'Bob' }], cc: [], bcc: [{ address: 'audit@example.net', name: '' }],
    subject: '合同确认', preview: '', attachmentCount: 2, sendAt: '2026-11-30T01:00:00Z', messageId: null, errorDetail: '',
    createdVia: 'api', apiKeyName: '报销 Agent', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', sentAt: null,
    replyTo: [], text: '请确认附件（纯文本）', html: '<p>请确认附件 <img src="cid:logo"></p>', headers: {}, replyToMessageId: null,
    forwardAttachmentsFrom: null,
    attachments: [
      { token: 'tok-logo', filename: 'logo.png', mimeType: 'image/png', size: 100, contentId: 'logo', disposition: 'inline' },
      { token: 'tok-pdf', filename: 'contract.pdf', mimeType: 'application/pdf', size: 2048, contentId: '', disposition: 'attachment' },
    ],
    ...overrides,
  };
}
const sentSummary = { id: 88, status: 'sent', errorDetail: '', recipientOutcomes: [] } as unknown as MessageSummary;

function show(state?: ComposeInitial) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: '/compose', element: <ComposePage /> },
    { path: '/drafts', element: <p>drafts page</p> },
    { path: '/sent', element: <p>sent page</p> },
    { path: '/mail/:id', element: <p>mail page</p> },
  ], { initialEntries: ['/drafts', { pathname: '/compose', state }], initialIndex: 1 });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router };
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of [mocks.get, mocks.update, mocks.create, mocks.draftSend, mocks.messageSend, mocks.toast]) mock.mockReset();
  mocks.remove.mockClear();
  mocks.user = { id: 1, role: 'user' };
});

describe('写信页编辑服务端草稿', () => {
  it('预填全部字段：发件身份按 mailboxId、收件人带显示名、HTML 正文优先、附件为已上传', async () => {
    mocks.get.mockResolvedValue(draft());
    show({ serverDraftId: 5 });
    expect(await screen.findByDisplayValue('合同确认')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '编辑草稿' })).toBeInTheDocument();
    expect(screen.getByText(/来源：API · 报销 Agent/)).toBeInTheDocument();
    expect(screen.getByText(/已安排在 .* 定时发送/)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('second@two.example');
    expect(screen.getByText('Bob <bob@example.net>')).toBeInTheDocument();
    expect(screen.getByText('audit@example.net')).toBeInTheDocument();
    expect(screen.getByLabelText(/正文/)).toHaveValue('<p>请确认附件 <img src="cid:logo"></p>');
    expect(screen.getByRole('switch', { name: '以 HTML 发送' })).toBeChecked();
    expect(screen.getByText('logo.png')).toBeInTheDocument();
    expect(screen.getAllByText('已上传')).toHaveLength(2);
    expect(mocks.get).toHaveBeenCalledWith(5, expect.anything());
  });

  it('发送：先 PATCH（带读到的版本，正文没改不带正文，内嵌图片保留 contentId）再用新版本 send，不写本机草稿、不走 /messages/send', async () => {
    mocks.get.mockResolvedValue(draft());
    mocks.update.mockResolvedValue(draft({ version: 4 }));
    mocks.draftSend.mockResolvedValue(sentSummary);
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.draftSend).toHaveBeenCalledWith(5, 4));
    const [id, body] = mocks.update.mock.calls[0]!;
    expect(id).toBe(5);
    expect(body).toEqual({
      from: { mailboxId: 10, displayName: '报销助手' },
      to: ['Bob <bob@example.net>'], cc: [], bcc: ['audit@example.net'], subject: '合同确认',
      attachmentTokens: [{ token: 'tok-logo', contentId: 'logo' }, 'tok-pdf'],
      replyToMessageId: null, forwardAttachmentsFrom: null, expectedVersion: 3,
    });
    expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.draftSend.mock.invocationCallOrder[0]!);
    expect(mocks.messageSend).not.toHaveBeenCalled();
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '邮件已提交发送', variant: 'success' }));
    expect(localStorage.getItem(draftKeyForUser(1))).toBeNull();
    expect(localStorage.getItem(sendAttemptKeyForUser(1))).toBeNull();
  });

  it('移除附件只从列表去掉、不调 DELETE /uploads；改了正文保存时只留当前格式并清空另一种', async () => {
    mocks.get.mockResolvedValue(draft());
    mocks.update.mockResolvedValue(draft({ version: 4 }));
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.click(screen.getByRole('button', { name: '移除 contract.pdf' }));
    expect(screen.queryByText('contract.pdf')).toBeNull();
    fireEvent.change(screen.getByLabelText(/正文/), { target: { value: '<p>改过的正文</p>' } });
    fireEvent.click(screen.getByRole('button', { name: '存到草稿箱' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.update.mock.calls[0]![1]).toMatchObject({
      html: '<p>改过的正文</p>', text: '', attachmentTokens: [{ token: 'tok-logo', contentId: 'logo' }], expectedVersion: 3,
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.draftSend).not.toHaveBeenCalled();
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('已保存，仍将在') }));
  });

  it('版本冲突（别处改过）：提示重新载入，不发送；重新载入后显示最新内容', async () => {
    mocks.get.mockResolvedValueOnce(draft()).mockResolvedValue(draft({ version: 6, subject: 'Agent 改过的主题' }));
    mocks.update.mockRejectedValue(new ApiError('草稿已被修改（当前版本 6），请读取最新内容后再改', {
      code: 'draft_state_conflict', httpStatus: 409, details: { draftStatus: 'scheduled', draftVersion: 6 },
    }));
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('草稿已在别处被修改');
    expect(mocks.draftSend).not.toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: '重新载入草稿' }));
    expect(await screen.findByDisplayValue('Agent 改过的主题')).toBeInTheDocument();
  });

  it('发送结果不明后重试：草稿已发出时直接查询原结果（重放），不再要求版本', async () => {
    mocks.get.mockResolvedValue(draft());
    mocks.update.mockResolvedValueOnce(draft({ version: 4 }))
      .mockRejectedValueOnce(new ApiError('草稿已发送，不能修改', { code: 'draft_state_conflict', httpStatus: 409, details: { draftStatus: 'sent', draftVersion: 6 } }));
    mocks.draftSend.mockRejectedValueOnce(new ApiError('网络连接失败', { code: 'network' })).mockResolvedValueOnce(sentSummary);
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿只会发出一次');
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(mocks.draftSend).toHaveBeenCalledTimes(2));
    expect(mocks.draftSend.mock.calls[1]).toEqual([5]);
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
  });

  it('422 全部拒收后读回新版本（内容未被别处改过），修正后再发用新版本', async () => {
    mocks.get.mockResolvedValueOnce(draft()).mockResolvedValue(draft({ version: 6, status: 'failed', messageId: 90, errorDetail: '550' }));
    mocks.update.mockResolvedValueOnce(draft({ version: 4 })).mockResolvedValueOnce(draft({ version: 7 }));
    mocks.draftSend.mockRejectedValueOnce(new ApiError('全部收件人发送失败', {
      code: 'delivery_failed', httpStatus: 422, details: { messageId: 90, recipientOutcomes: [{ address: 'bob@example.net', status: 'failed', error: '550' }] },
    })).mockResolvedValueOnce(sentSummary);
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('修正后可以再次发送这份草稿');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls[1]![1]).toMatchObject({ expectedVersion: 6 });
    await waitFor(() => expect(mocks.draftSend).toHaveBeenLastCalledWith(5, 7));
  });

  it('有改动时离开：提示保存到草稿箱，保存成功才离开', async () => {
    mocks.get.mockResolvedValue(draft());
    mocks.update.mockResolvedValue(draft({ version: 4 }));
    show({ serverDraftId: 5 });
    await screen.findByDisplayValue('合同确认');
    fireEvent.change(screen.getByLabelText(/主题/), { target: { value: '改过的主题' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const prompt = await screen.findByRole('dialog', { name: '保存对草稿的修改？' });
    fireEvent.click(within(prompt).getByRole('button', { name: '保存到草稿箱' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(5, expect.objectContaining({ subject: '改过的主题', expectedVersion: 3 })));
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
    expect(localStorage.getItem(draftKeyForUser(1))).toBeNull();
  });

  it('已发送的草稿不能再编辑', async () => {
    mocks.get.mockResolvedValue(draft({ status: 'sent', messageId: 88 }));
    show({ serverDraftId: 5 });
    expect(await screen.findByText(/这份草稿已经发送，不能再编辑/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看发件记录' })).toHaveAttribute('href', '/mail/88');
  });
});

describe('新邮件存到草稿箱与定时发送', () => {
  const filled: ComposeInitial = { fromAddress: 'first@one.example', to: ['to@example.com'], subject: '周报', body: '本周进展' };
  const created = (overrides: Partial<Draft> = {}) => draft({ id: 31, status: 'draft', version: 1, sendAt: null, attachments: [], ...overrides });

  it('存到草稿箱：内容可以不完整，POST 带幂等键，成功后清掉本机草稿并去草稿箱', async () => {
    mocks.create.mockResolvedValue(created());
    show({ to: ['to@example.com'], body: '还没写完' });
    fireEvent.change(screen.getByLabelText(/正文/), { target: { value: '还没写完…' } });
    await waitFor(() => expect(localStorage.getItem(draftKeyForUser(1))).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '存到草稿箱' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const [body, key] = mocks.create.mock.calls[0]!;
    expect(body).toEqual({ from: { mailboxId: 9 }, to: ['to@example.com'], cc: [], bcc: [], subject: '', text: '还没写完…', attachmentTokens: [] });
    expect(key).toEqual(expect.any(String));
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '已存到草稿箱' }));
    expect(localStorage.getItem(draftKeyForUser(1))).toBeNull();
    expect(mocks.messageSend).not.toHaveBeenCalled();
  });

  it('定时发送：按本地时区转成带偏移的 ISO 时间提交', async () => {
    mocks.create.mockResolvedValue(created({ status: 'scheduled', sendAt: '2026-11-30T01:00:00Z' }));
    show(filled);
    fireEvent.click(screen.getByRole('button', { name: '定时发送' }));
    const dialog = await screen.findByRole('dialog', { name: '定时发送' });
    const at = new Date(Date.now() + 2 * 3_600_000);
    at.setSeconds(0, 0);
    fireEvent.change(within(dialog).getByLabelText('发送时间'), { target: { value: toLocalInputValue(at) } });
    fireEvent.click(within(dialog).getByRole('button', { name: '安排发送' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const { sendAt, ...rest } = mocks.create.mock.calls[0]![0] as { sendAt: string };
    expect(sendAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(sendAt)).toBe(at.getTime());
    expect(rest).toMatchObject({ from: { mailboxId: 9 }, subject: '周报', text: '本周进展' });
    expect(await screen.findByText('drafts page')).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^已安排在 .* 发送$/) }));
  });

  it('定时发送的时间范围：早于 1 分钟后、晚于 30 天内都不提交', async () => {
    show(filled);
    fireEvent.click(screen.getByRole('button', { name: '定时发送' }));
    const dialog = await screen.findByRole('dialog', { name: '定时发送' });
    const input = within(dialog).getByLabelText('发送时间');
    fireEvent.change(input, { target: { value: toLocalInputValue(new Date()) } });
    fireEvent.click(within(dialog).getByRole('button', { name: '安排发送' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('定时发送时间最早为 1 分钟后');
    fireEvent.change(input, { target: { value: toLocalInputValue(new Date(Date.now() + 31 * 86_400_000)) } });
    fireEvent.click(within(dialog).getByRole('button', { name: '安排发送' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('定时发送时间最晚为 30 天内');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('内容不完整时不弹出定时对话框，先标出缺的字段', async () => {
    show({ fromAddress: 'first@one.example', to: ['to@example.com'], body: '正文' });
    fireEvent.click(screen.getByRole('button', { name: '定时发送' }));
    expect(await screen.findByText('请填写主题')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '定时发送' })).toBeNull();
  });
});
