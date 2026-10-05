import { EXTERNAL_MESSAGE_MAX_BYTES, type UserNotifyPrefs } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { hmacSha256Base64 } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email-address.js';
import { bytesToBase64, encodeBodyBase64, foldBase64, foldMimeHeaders, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { retainExternalAttachments } from './external-attachment.js';
import { injectAttachmentLinks } from './attachment-links.js';
import { FORWARD_DOMAIN_DAILY_LIMIT, FORWARD_TARGET_DAILY_LIMIT, recordDeliveryResult } from './notification-jobs.js';

export interface ForwardAttachment {
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);

export interface ForwardMail {
  messageId: number;
  ownerIds: number[];
  fromAddress: string;
  fromName: string;
  toAddress: string;
  domain: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string[];
  attachments: ForwardAttachment[];
}

export async function relayMarker(env: Env): Promise<string> {
  return hmacSha256Base64(new TextEncoder().encode(env.jwt_secret), 'hpc-mail-relay:v1');
}

/**
 * 中转转发：原生 forward() 仅对 Email Routing 已验证 destination 生效，目标未验证时
 * 降级为 send_email binding 以 no-reply@收件域名 重新打包发送——保留原始标题/正文/附件，
 * Reply-To 指回原发件人，正文顶部加转发元信息块。
 */
async function relayForward(env: Env, target: string, mail: ForwardMail): Promise<void> {
  // 动态 import：`cloudflare:email`/`mimetext` 静态加载会让 vitest 的 workerd 崩（同 outbound.ts）
  const [{ EmailMessage }, { createMimeMessage }] = await Promise.all([
    import('cloudflare:email'),
    import('mimetext/browser'),
  ]);
  const sender = `no-reply@${mail.domain}`;
  const origin = mail.fromName ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress;
  const metaLines = [
    `原始发件人: ${origin}`,
    `原收件地址: ${mail.toAddress}`,
    '直接回复本邮件将发送给原始发件人。',
  ];

  let text = mail.text;
  let html = mail.html;
  let relayedAttachments = mail.attachments;
  const encodedBytes = Math.ceil(new TextEncoder().encode(text + html).length * 1.38) +
    mail.attachments.reduce((sum, attachment) => sum + Math.ceil(attachment.content.byteLength * 1.38), 0);
  if (mail.attachments.length && encodedBytes > EXTERNAL_MESSAGE_MAX_BYTES) {
    const rows = await createDb(env).select().from(attachments)
      .where(eq(attachments.messageId, mail.messageId)).all();
    if (rows.length !== mail.attachments.length) throw new Error('转发附件尚未完整保存，无法生成下载链接');
    const retained = await retainExternalAttachments(env, rows, env.site_origin ?? 'https://hpc.email');
    const linked = injectAttachmentLinks(text, html, rows.map(row => ({
      filename: row.filename, size: row.size, contentId: row.contentId, url: retained.get(row.id)!,
    })));
    text = linked.text;
    html = linked.html;
    relayedAttachments = [];
  }
  if (Math.ceil(new TextEncoder().encode(text + html).length * 1.38) > EXTERNAL_MESSAGE_MAX_BYTES) {
    throw new Error('转发正文超过外发大小上限，请在邮箱网站查看完整邮件');
  }

  const msg = createMimeMessage();
  msg.setSender({ name: `${mail.fromName || mail.fromAddress} (via HPC Mail)`, addr: sender });
  msg.setRecipient(target);
  msg.setSubject(mail.subject || '(无主题)');
  msg.setHeader('X-HPC-Mail-Relay', await relayMarker(env));
  const replies = mail.replyTo.length ? mail.replyTo : [mail.fromAddress].filter(Boolean);
  msg.addMessage({
    contentType: 'text/plain',
    charset: 'UTF-8',
    encoding: 'base64',
    data: encodeBodyBase64(
      `———— HPC Mail 转发 ————\n${metaLines.join('\n')}\n————————————————\n\n${text || htmlToText(html)}`,
    ),
  });
  if (html) {
    const metaHtml =
      '<div style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #8b8fa3;background:#f5f6f8;color:#4b4f5c;font-size:12px;line-height:1.9">' +
      '<div style="font-weight:600">HPC Mail 转发</div>' +
      metaLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') +
      '</div>';
    msg.addMessage({
      contentType: 'text/html',
      charset: 'UTF-8',
      encoding: 'base64',
      data: encodeBodyBase64(metaHtml + html),
    });
  }
  for (const a of relayedAttachments) {
    // 附件 Base64 与不可信 MIME 参数沿用统一编码、清洗规则。
    msg.addAttachment({
      filename: sanitizeFilename(a.filename),
      contentType: sanitizeMimeType(a.mimeType),
      data: foldBase64(bytesToBase64(a.content)),
      ...(a.disposition === 'inline' && a.contentId
        ? { inline: true, headers: { 'Content-ID': `<${a.contentId}>` } } : {}),
    });
  }
  // mimetext 的 Reply-To Setter 只允许单个 Mailbox；最终原文添加完整地址列表。
  const raw = msg.asRaw();
  const replyHeader = replies.length ? `Reply-To: ${replies.map(normalizeEmail).join(', ')}\r\n` : '';
  await env.email.send(new EmailMessage(sender, target, foldMimeHeaders(replyHeader + raw)));
}

/** 原生收件与站内互投使用同一归属偏好、限额及环路保护。 */
export async function forwardReceivedMail(
  env: Env,
  mail: ForwardMail,
  prefs: UserNotifyPrefs[],
  native?: ForwardableEmailMessage,
): Promise<void> {
  if (native?.headers.get('x-hpc-mail-relay') === await relayMarker(env)) return;
  const ownersByTarget = new Map<string, number[]>();
  prefs.forEach((pref, index) => {
    if (!pref.forward.enabled) return;
    for (const rawTarget of pref.forward.addresses) {
      const target = normalizeEmail(rawTarget);
      if (!target || target === mail.toAddress) continue;
      const owners = ownersByTarget.get(target) ?? [];
      if (mail.ownerIds[index] !== undefined) owners.push(mail.ownerIds[index]!);
      ownersByTarget.set(target, owners);
    }
  });
  const window = dayWindow();
  for (const [target, owners] of ownersByTarget) {
    let status: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let detail = '';
    try {
      const [domainUsage, targetUsage] = await Promise.all([
        bumpCounter(env, 'fwd-domain', mail.domain, window),
        bumpCounter(env, 'fwd-target', target, window),
      ]);
      if (domainUsage.count > FORWARD_DOMAIN_DAILY_LIMIT || targetUsage.count > FORWARD_TARGET_DAILY_LIMIT) {
        status = 'skipped';
        detail = '今日转发额度已用尽';
      } else {
        let nativeSucceeded = false;
        if (native) {
          try { await native.forward(target); nativeSucceeded = true; }
          catch { /* 未验证目标改用 Cloudflare 中转。 */ }
        }
        if (!nativeSucceeded) await relayForward(env, target, mail);
      }
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
      console.error(`转发到 ${target} 失败:`, error);
    }
    for (const userId of new Set(owners)) {
      try { await recordDeliveryResult(env, { userId, messageId: mail.messageId,
        channel: 'forward', target, status, error: detail }); }
      catch (error) { console.error('转发结果记录失败:', error); }
    }
  }
}
