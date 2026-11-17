import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAuth, MessageDetail } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({ override: {} as Partial<MessageDetail> }));
vi.mock('@/api/resources', () => ({
  messageApi: {
    detail: vi.fn(async (id: number) => ({
      id, address: 'owner@example.com', direction: 'inbound', isRead: true, isStarred: false,
      fromAddress: 'support@bank.example', fromName: 'Bank', subject: `mail-${id}`,
      bodyHtml: '', bodyText: 'hello', verificationCode: '', verificationLink: '', status: 'received', errorDetail: '',
      recipients: { to: ['owner@example.com'], cc: [], bcc: [] },
      attachments: [], hasRaw: true, createdAt: '2026-11-17T00:00:00Z',
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

const PASS: MessageAuth = { spf: 'pass', dkim: 'pass', dkimDomain: 'bank.example', dmarc: 'pass', aligned: true };

async function show(override: Partial<MessageDetail>) {
  mocks.override = override;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/mail/1']}>
        <Routes><Route path="/mail/:id" element={<MessagePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'mail-1' });
}

beforeEach(() => { mocks.override = {}; });

describe('MessagePage 发件认证提示', () => {
  it('From 未对齐：醒目提示可能伪造，并列出三项结果与签名域', async () => {
    await show({ auth: { spf: 'softfail', dkim: 'pass', dkimDomain: 'mailer.example', dmarc: 'none', aligned: false } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('发件人身份未通过验证');
    expect(alert).toHaveTextContent('support@bank.example');
    expect(alert).toHaveTextContent('SPF softfail · DKIM pass（mailer.example） · DMARC none');
  });

  it('DMARC 明确失败时即使判定对齐也提示；没有签名域时不显示括号', async () => {
    await show({ auth: { ...PASS, dkim: 'fail', dkimDomain: '', dmarc: 'fail' } });
    expect(screen.getByRole('alert')).toHaveTextContent('SPF pass · DKIM fail · DMARC fail');
  });

  it('通过认证、没有认证结果（历史邮件）与发件（即使带了结果）都不提示', async () => {
    for (const override of [{ auth: PASS }, { auth: null }, { direction: 'outbound' as const, auth: { ...PASS, aligned: false } }]) {
      await show(override);
      expect(screen.queryByText('发件人身份未通过验证')).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('未通过认证时验证链接按钮降为次要样式并提示确认', async () => {
    await show({ verificationLink: 'https://bank.example/verify?t=1', auth: { ...PASS, aligned: false } });
    expect(screen.getByText('发件人未通过验证，请确认后再打开')).toBeInTheDocument();
    cleanup();
    await show({ verificationLink: 'https://bank.example/verify?t=1', auth: PASS });
    expect(screen.queryByText('发件人未通过验证，请确认后再打开')).not.toBeInTheDocument();
  });
});
