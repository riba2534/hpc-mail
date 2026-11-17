import type { MessageSummary } from '@hpc-mail/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MessageRow } from './message-row';

const outbound = (extra: Partial<MessageSummary>): MessageSummary => ({
  id: 1, direction: 'outbound', address: 'me@example.com', domain: 'example.com', fromAddress: 'me@example.com', fromName: '',
  subject: 'report', preview: 'body', verificationCode: '', status: 'sent', errorDetail: '', recipientsTo: ['to@example.com'],
  isRead: true, isStarred: false, hasAttachments: false, size: 4, createdAt: '2026-11-17T00:00:00Z', ...extra,
});

function show(message: MessageSummary) {
  render(<MemoryRouter><MessageRow message={message} href="/mail/1" onToggleStar={() => {}} /></MemoryRouter>);
}

describe('外发状态徽标', () => {
  it('投递中断的外发显示「待确认」并给出说明，不当成部分失败', () => {
    show(outbound({ status: 'unknown', errorDetail: '投递中断，结果未确认: to@example.com' }));
    expect(screen.getByText('待确认')).toBeInTheDocument();
    expect(screen.queryByText('部分失败')).toBeNull();
    expect(screen.getByText('投递中断，结果未确认: to@example.com')).toHaveClass('text-caution');
  });

  it('投递中显示「投递中」；部分失败仍为红色「部分失败」', () => {
    show(outbound({ status: 'pending' }));
    expect(screen.getByText('投递中')).toBeInTheDocument();
    show(outbound({ id: 2, status: 'sent', errorDetail: '部分收件人失败: bad@example.com: rejected' }));
    expect(screen.getByText('部分失败')).toBeInTheDocument();
    expect(screen.getByText('部分收件人失败: bad@example.com: rejected')).toHaveClass('text-critical');
  });
});
