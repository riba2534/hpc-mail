import type { MessageDetail } from '@hpc-mail/shared';
import { formatDateTime } from '@/lib/format';

/** 通过 router location.state 传给写邮件页的预填数据 */
export interface ComposeInitial {
  /** 期望的发件地址（本站 mailbox），用于预选身份 */
  fromAddress?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  isHtml?: boolean;
  /** 回复的站内邮件 id，后端据此注入 In-Reply-To / References */
  replyToMessageId?: number;
  /** 转发来源邮件 id：后端据此带上原附件 */
  forwardAttachmentsFrom?: number;
  /** 页面标题用；不靠主题前缀猜测（中文「转发:」会误判） */
  mode?: 'reply' | 'forward' | 'resend';
}

function withPrefix(subject: string, prefix: 'Re' | 'Fwd'): string {
  const trimmed = subject.trim();
  const pattern = prefix === 'Re' ? /^re:/i : /^(fwd?|转发):/i;
  return pattern.test(trimmed) ? trimmed : `${prefix}: ${trimmed}`;
}

/** 浏览器端 HTML→纯文本：用于 HTML-only 邮件的引用降级，避免丢失原文 */
function htmlToPlainText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('style, script').forEach((el) => el.remove());
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}

function quotedBody(message: MessageDetail): string {
  const from = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
  const header = [
    '',
    '',
    '----- 原始邮件 -----',
    `发件人：${from}`,
    `时间：${formatDateTime(message.createdAt)}`,
    `主题：${message.subject}`,
    '',
  ].join('\n');
  // 纯文本优先；HTML-only 邮件降级为从 HTML 提取的纯文本，而不是丢弃原文
  const source = message.bodyText.trim() || (message.bodyHtml ? htmlToPlainText(message.bodyHtml) : '');
  const quoted = source
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${header}\n${quoted}\n`;
}

/** 从一封邮件回复：outbound 回给原收件人，inbound 回给发件人 */
export function buildReply(message: MessageDetail): ComposeInitial {
  const outbound = message.direction === 'outbound';
  const to = outbound ? message.recipients.to : message.replyTo?.length ? message.replyTo : [message.fromAddress];
  return {
    fromAddress: message.address,
    to: to.filter(Boolean),
    subject: withPrefix(message.subject, 'Re'),
    body: quotedBody(message),
    isHtml: false,
    replyToMessageId: message.id,
    mode: 'reply',
  };
}

/** 回复全部：收件人 = 发件人 + 原 to/cc（去掉自己这个地址），避免丢失线程参与者 */
export function buildReplyAll(message: MessageDetail): ComposeInitial {
  const self = message.address.toLowerCase();
  const outbound = message.direction === 'outbound';
  const primary = outbound ? message.recipients.to : message.replyTo?.length ? message.replyTo : [message.fromAddress];
  const others = [...message.recipients.to, ...message.recipients.cc].filter(
    (addr) => addr.toLowerCase() !== self && !primary.includes(addr),
  );
  return {
    fromAddress: message.address,
    to: primary.filter(Boolean),
    cc: [...new Set(others)],
    subject: withPrefix(message.subject, 'Re'),
    body: quotedBody(message),
    isHtml: false,
    replyToMessageId: message.id,
    mode: 'reply',
  };
}

export function buildForward(message: MessageDetail): ComposeInitial {
  const hasAttachments = message.attachments.length > 0;
  const attachmentNote = hasAttachments
    ? `\n（原邮件的 ${message.attachments.length} 个附件将随本次转发一并发送）\n`
    : '';
  return {
    fromAddress: message.address,
    to: [],
    subject: withPrefix(message.subject, 'Fwd'),
    body: attachmentNote + quotedBody(message),
    isHtml: false,
    forwardAttachmentsFrom: hasAttachments ? message.id : undefined,
    mode: 'forward',
  };
}

/** 重新发送一封失败的外发邮件：沿用原收件人/主题/正文，让用户可修正后重发 */
export function buildResend(message: MessageDetail, failedOnly = false): ComposeInitial {
  const failures = new Set((message.recipientOutcomes ?? []).filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.address.toLowerCase()));
  const recipients = (addresses: string[]) => failedOnly ? addresses.filter((address) => failures.has(address.toLowerCase())) : addresses;
  const to = recipients(message.recipients.to);
  const cc = recipients(message.recipients.cc);
  const bcc = recipients(message.recipients.bcc);
  return {
    fromAddress: message.address,
    to,
    cc,
    bcc,
    subject: message.subject,
    body: message.bodyHtml || message.bodyText,
    isHtml: Boolean(message.bodyHtml),
    forwardAttachmentsFrom: message.attachments.length ? message.id : undefined,
    mode: 'resend',
  };
}
