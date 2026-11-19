import { describe, expect, it } from 'vitest';
import type { MessageDetail } from '@hpc-mail/shared';
import { buildForward, buildReply, buildReplyAll, buildResend } from './compose-init';

function makeDetail(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: 42,
    direction: 'inbound',
    address: 'me@hpc.email',
    domain: 'hpc.email',
    fromAddress: 'alice@example.com',
    fromName: 'Alice',
    subject: '账单通知',
    preview: '',
    verificationCode: '',
    status: 'received',
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    size: 0,
    createdAt: '2026-07-15T02:00:00.000Z',
    recipients: { to: ['me@hpc.email'], cc: [], bcc: [] },
    bodyText: '您的账单已生成\n请查收',
    bodyHtml: '',
    errorDetail: '',
    attachments: [],
    hasRaw: false,
    ...overrides,
  };
}

describe('buildReply / buildForward', () => {
  it('转发无附件的邮件时也携带来源，离线移除追踪链接', () => {
    const forward = buildForward(makeDetail({
      bodyText: 'Continue at https://news.example.test/ls/click?tracking=sample',
      attachments: [],
    }));
    expect(forward.forwardAttachmentsFrom).toBe(42);
    expect(forward.body).toContain('追踪链接已移除');
    expect(forward.body).not.toContain('tracking=sample');
  });

  it('从只有 HTML 的原信取出直达链接并保留签名', () => {
    const forward = buildForward(makeDetail({
      bodyText: '',
      bodyHtml: '<p><a href="https://example.test/login?token=a%2Fb">Verify</a></p>',
    }));
    expect(forward.body).toContain('Verify (https://example.test/login?token=a%2Fb)');
  });

  it('回复预填收件人、Re: 主题、引用块、发件身份与 replyToMessageId', () => {
    const reply = buildReply(makeDetail());
    expect(reply.to).toEqual(['alice@example.com']);
    expect(reply.subject).toBe('Re: 账单通知');
    expect(reply.replyToMessageId).toBe(42);
    expect(reply.fromAddress).toBe('me@hpc.email');
    expect(reply.isHtml).toBe(false);
    expect(reply.body).toContain('----- 原始邮件 -----');
    expect(reply.body).toContain('发件人：Alice <alice@example.com>');
    expect(reply.body).toContain('> 您的账单已生成');
  });

  it('已有 Re: 前缀时不重复叠加', () => {
    expect(buildReply(makeDetail({ subject: 'Re: 账单通知' })).subject).toBe('Re: 账单通知');
  });

  it('转发用 Fwd: 前缀、收件人留空、无 replyToMessageId', () => {
    const forward = buildForward(makeDetail());
    expect(forward.subject).toBe('Fwd: 账单通知');
    expect(forward.to).toEqual([]);
    expect(forward.replyToMessageId).toBeUndefined();
    expect(forward.body).toContain('----- 原始邮件 -----');
  });
  it('reply and reply-all use Reply-To rather than a relay envelope sender', () => {
    const message = makeDetail({replyTo:['original@example.com'],recipients:{to:['me@hpc.email','participant@example.com'],cc:['copy@example.com'],bcc:[]}});
    expect(buildReply(message).to).toEqual(['original@example.com']);
    expect(buildReplyAll(message)).toMatchObject({to:['original@example.com'],cc:['participant@example.com','copy@example.com']});
  });
  it('resending retains BCC, HTML and the original attachments', () => {
    const message = makeDetail({direction:'outbound',recipients:{to:['to@example.com'],cc:['cc@example.com'],bcc:['bcc@example.com']},bodyHtml:'<p>formatted</p>',attachments:[{id:1,filename:'file.txt',mimeType:'text/plain',size:4,contentId:'',disposition:'attachment',url:'/signed'}]});
    expect(buildResend(message)).toMatchObject({to:['to@example.com'],cc:['cc@example.com'],bcc:['bcc@example.com'],isHtml:true,body:'<p>formatted</p>',forwardAttachmentsFrom:42});
  });
  it('only failed recipients are retried, retaining Cc/Bcc grouping and excluding all successful targets', () => {
    const message = makeDetail({direction:'outbound',recipients:{to:['ok@example.com'],cc:['failed-cc@example.com'],bcc:['failed-secret@example.com']},recipientOutcomes:[{address:'ok@example.com',status:'sent'},{address:'failed-cc@example.com',status:'failed'},{address:'failed-secret@example.com',status:'failed'}]});
    const result = buildResend(message,true);
    expect(result.to).toEqual([]);
    expect(result.cc).toEqual(['failed-cc@example.com']);
    expect(result.bcc).toEqual(['failed-secret@example.com']);
    expect(message.recipients.bcc).toEqual(['failed-secret@example.com']);
  });
  it('bounced recipients from delivery receipts are retried like failed ones; delivered and complained are not', () => {
    const message = makeDetail({direction:'outbound',recipients:{to:['ok@example.com','spam@example.com','gone@example.com'],cc:[],bcc:[]},recipientOutcomes:[{address:'ok@example.com',status:'delivered',event:'delivered'},{address:'spam@example.com',status:'complained',event:'complained'},{address:'gone@example.com',status:'bounced',event:'bounced',error:'550 5.1.1 User unknown'}]});
    expect(buildResend(message,true)).toMatchObject({to:['gone@example.com'],cc:[],bcc:[]});
  });
  it('unconfirmed (unknown) recipients may already have the mail: listed, never retried automatically', () => {
    const message = makeDetail({direction:'outbound',status:'unknown',recipients:{to:['ok@example.com','maybe@example.com'],cc:['failed@example.com'],bcc:[]},recipientOutcomes:[{address:'ok@example.com',status:'sent'},{address:'maybe@example.com',status:'unknown',error:'投递中断，结果未确认'},{address:'failed@example.com',status:'failed',error:'rejected'}]});
    const retry = buildResend(message,true);
    expect(retry).toMatchObject({to:[],cc:['failed@example.com'],bcc:[],unconfirmed:['maybe@example.com']});
    expect(buildResend(message)).not.toHaveProperty('unconfirmed');
  });
});
