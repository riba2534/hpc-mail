import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ override: {} as Partial<MessageDetail> }));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'outbound', isRead: true, isStarred: false,
      fromAddress: 'owner@example.com', fromName: '', subject: `mail-${id}`,
      bodyHtml: '', bodyText: 'hello', verificationCode: '', verificationLink: '', status: 'sent', errorDetail: '',
      recipients: { to: ['a@outside.com', 'b@outside.com', 'c@outside.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: false, createdAt: '2026-10-01T00:00:00Z',
      ...mocks.override,
    })),
    thread: vi.fn(async () => ({ items: [] })),
    markRead: vi.fn(async () => ({ changed: 0 })),
  },
}));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({ useMailboxesQuery: () => ({ data: [{ address: 'owner@example.com' }] }) }));
vi.mock('@/features/inbox/use-star', () => ({ useStarMutation: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/use-session', () => ({ useCurrentUser: () => ({ id: 1, role: 'user' }) }));
import { MessagePage } from './message-page';

function show(override: Partial<MessageDetail>) {
  mocks.override = override;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/mail/1']}>
        <Routes><Route path="/mail/:id" element={<MessagePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { mocks.override = {}; });

describe('MessagePage 发件投递状态', () => {
  it('pending 显示投递中，不当成发送问题', async () => {
    show({ status: 'pending' });
    expect(await screen.findByRole('status')).toHaveTextContent('投递中，结果尚未回填');
    expect(screen.queryByText(/发送失败|部分收件人失败|投递结果未确认/)).not.toBeInTheDocument();
  });

  it('unknown 提示先确认再补发，列出结果未确认的收件人，失败的仍可单独重试', async () => {
    show({
      status: 'unknown',
      recipientOutcomes: [
        { address: 'a@outside.com', status: 'sent' },
        { address: 'b@outside.com', status: 'unknown', error: '投递中断，结果未确认' },
        { address: 'c@outside.com', status: 'failed', error: 'mailbox full' },
      ],
    });
    expect(await screen.findByText('投递结果未确认：部分收件人可能已收到，补发前先确认')).toBeInTheDocument();
    const unknown = screen.getByRole('list', { name: '结果未确认的收件人' });
    expect(unknown).toHaveTextContent('b@outside.com：投递中断，结果未确认');
    expect(unknown).not.toHaveTextContent('a@outside.com');
    expect(unknown).not.toHaveTextContent('c@outside.com');
    expect(screen.getByText('c@outside.com：mailbox full')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仅重试失败收件人' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('投递回执的退信列为失败收件人可单独重试；投诉的收件人单独提示', async () => {
    show({
      status: 'delivered', errorDetail: '部分收件人失败: b@outside.com: 550 5.1.1 User unknown',
      recipientOutcomes: [
        { address: 'a@outside.com', status: 'delivered', event: 'delivered', eventAt: '2026-10-01T00:01:00Z' },
        { address: 'b@outside.com', status: 'bounced', event: 'bounced', smtpStatus: '550 5.1.1', error: '550 5.1.1 User unknown' },
        { address: 'c@outside.com', status: 'complained', event: 'complained' },
      ],
    });
    expect(await screen.findByText('部分收件人失败')).toBeInTheDocument();
    expect(screen.getByText('b@outside.com：550 5.1.1 User unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仅重试失败收件人' })).toBeInTheDocument();
    expect(screen.getByText(/已送达，但这些收件人把邮件标记为垃圾邮件.*c@outside\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/a@outside\.com：/)).not.toBeInTheDocument();
  });

  it('历史 bounced 等未知状态不再有专门分支：没有错误详情时不显示问题提示', async () => {
    show({ status: 'bounced' });
    await screen.findByText('mail-1');
    expect(screen.queryByText(/退信|发送失败|部分收件人失败|投递结果未确认/)).not.toBeInTheDocument();
  });
});

describe('MessagePage 内联图', () => {
  it('正文里已显示的内联图不在附件区重复列出，未被引用的照常列出', async () => {
    show({
      direction: 'inbound', status: 'received',
      bodyHtml: '<p><img src="/api/attachments/8?exp=1&amp;sig=x"></p>',
      attachments: [
        { id: 8, filename: 'logo.png', mimeType: 'image/png', size: 100, contentId: 'logo', disposition: 'inline', inline: true, url: '/api/attachments/8?exp=1&sig=x' },
        { id: 9, filename: '报告.pdf', mimeType: 'application/pdf', size: 2048, contentId: '', disposition: 'attachment', inline: false, url: '/api/attachments/9?exp=1&sig=y' },
        { id: 10, filename: 'unused.png', mimeType: 'image/png', size: 100, contentId: 'unused', disposition: 'inline', inline: false, url: '/api/attachments/10?exp=1&sig=z' },
      ],
    });
    expect(await screen.findByText('2 个附件')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /报告\.pdf/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unused\.png/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /logo\.png/ })).not.toBeInTheDocument();
  });

  it('全部附件都是已显示的内联图时不显示附件区', async () => {
    show({
      direction: 'inbound', status: 'received',
      attachments: [{ id: 8, filename: 'logo.png', mimeType: 'image/png', size: 100, contentId: 'logo', disposition: 'inline', inline: true, url: '/api/attachments/8?exp=1&sig=x' }],
    });
    await screen.findByText('mail-1');
    expect(screen.queryByText(/个附件/)).not.toBeInTheDocument();
  });
});
