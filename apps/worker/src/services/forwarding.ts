import { EXTERNAL_MESSAGE_MAX_BYTES, type UserNotifyPrefs } from '@hpc-mail/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments, users } from '../db/schema.js';
import { hmacSha256Base64 } from '../lib/crypto.js';
import { chunk } from '../lib/d1.js';
import { normalizeEmail } from '../lib/email-address.js';
import { bytesToBase64, encodeBodyBase64, foldBase64, foldMimeHeaders, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { convertHtmlToText, type MailText } from '../lib/text.js';
import type { Env } from '../types.js';
import { dayWindow, reserveCounters } from './rate-counter.js';
import { retainExternalAttachments } from './external-attachment.js';
import { injectAttachmentLinks } from './attachment-links.js';
import { saveDeliveryRefs } from './delivery-events.js';
import { FORWARD_DOMAIN_DAILY_LIMIT, FORWARD_TARGET_DAILY_LIMIT, recordDeliveryResult, type ForwardMode } from './notification-jobs.js';
import type { NotifyOwner } from './notify-prefs.js';
import { getSettings } from './setting.js';

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
const RELAY_TEXT_TRUNCATED = '（正文过长，纯文本版本只包含开头部分，完整内容请查看 HTML 版本）';

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
  /** 收件链路的正文视图：中转正文未改写时复用同一份 HTML → 纯文本转换结果 */
  mailText?: MailText;
}

export async function relayMarker(env: Env): Promise<string> {
  return hmacSha256Base64(new TextEncoder().encode(env.jwt_secret), 'hpc-mail-relay:v1');
}

/**
 * 中转转发：原生 forward() 仅对 Email Routing 已验证 destination 生效，目标未验证时
 * 降级为 send_email binding 以 no-reply@收件域名 重新打包发送——保留原始标题/正文/附件，
 * Reply-To 指回原发件人，正文顶部加转发元信息块。返回 send() 给出的 Cloudflare 消息 ID（投递回执据此关联）。
 */
async function relayForward(env: Env, target: string, mail: ForwardMail): Promise<string | null> {
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

  // 附件改为下载链接时正文已改写，只能重新转换
  const reused = mail.mailText && text === mail.text && html === mail.html ? mail.mailText : null;
  const converted = reused ? { text: reused.plain, truncated: reused.plainTruncated }
    : text ? { text, truncated: false } : convertHtmlToText(html);
  // HTML 超长时纯文本只转换了开头，HTML 部分仍完整转发
  const plainText = converted.truncated ? `${converted.text}\n\n${RELAY_TEXT_TRUNCATED}` : converted.text;
  const msg = createMimeMessage();
  msg.setSender({ name: `${mail.fromName || mail.fromAddress} (via HPC Mail)`, addr: sender });
  msg.setRecipient(target);
  msg.setSubject(mail.subject || '(无主题)');
  msg.setHeader('X-HPC-Mail-Relay', await relayMarker(env));
  // RFC 3834：自动转发的信，收件方不应再自动回复（假期回复、退信机器人）
  msg.setHeader('Auto-Submitted', 'auto-forwarded');
  const replies = mail.replyTo.length ? mail.replyTo : [mail.fromAddress].filter(Boolean);
  msg.addMessage({
    contentType: 'text/plain',
    charset: 'UTF-8',
    encoding: 'base64',
    data: encodeBodyBase64(
      `———— HPC Mail 转发 ————\n${metaLines.join('\n')}\n————————————————\n\n${plainText}`,
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
  return (await env.email.send(new EmailMessage(sender, target, foldMimeHeaders(replyHeader + raw))))?.messageId || null;
}

/** 中转转发的日计数：全站一格（subject `instance`）与按归属人（subject 为用户 id），按天窗口 */
export const FORWARD_RELAY_SCOPE = 'fwd-relay';
export const FORWARD_RELAY_USER_SCOPE = 'fwd-relay-user';

/** 转发归属人：收件链路传已读出的状态与偏好；站内互投只传偏好（与 mail.ownerIds 按下标对应），状态在这里补读 */
export type ForwardOwners = Map<number, NotifyOwner> | UserNotifyPrefs[];

/**
 * 开启转发且仍启用的归属人。只给偏好时只为开启了转发的人查一次状态（在 waitUntil 里，不在收件 Ack 前）；
 * 已停用的归属人原生与中转都不转发。
 */
async function activeForwarders(env: Env, ownerIds: number[], owners: ForwardOwners): Promise<{ userId: number; prefs: UserNotifyPrefs }[]> {
  if (owners instanceof Map) {
    return ownerIds.flatMap((userId) => {
      const owner = owners.get(userId);
      return owner?.active && owner.prefs.forward.enabled ? [{ userId, prefs: owner.prefs }] : [];
    });
  }
  const enabled = ownerIds.flatMap((userId, index) =>
    owners[index]?.forward.enabled ? [{ userId, prefs: owners[index]! }] : []);
  if (!enabled.length) return [];
  const active = new Set<number>();
  for (const ids of chunk([...new Set(enabled.map((item) => item.userId))])) {
    const rows = await createDb(env).select({ id: users.id }).from(users)
      .where(and(inArray(users.id, ids), eq(users.status, 'active'))).all();
    for (const row of rows) active.add(row.id);
  }
  return enabled.filter((item) => active.has(item.userId));
}

/**
 * 中转额度：全站与归属人两个日计数同时占一格。同一目标有多位归属人（未认领地址归全部管理员）时
 * 按顺序找第一位还有额度的人计入，全部用尽才跳过；全站额度用尽时不再逐人尝试。返回跳过原因，有额度时为空串。
 */
async function reserveRelay(env: Env, window: number, userIds: number[], quota: { relayDaily: number; relayPerUserDaily: number }): Promise<string> {
  for (const userId of userIds) {
    const [siteFull, userFull] = await reserveCounters(env, [
      { scope: FORWARD_RELAY_SCOPE, subject: 'instance', window, limit: quota.relayDaily },
      { scope: FORWARD_RELAY_USER_SCOPE, subject: String(userId), window, limit: quota.relayPerUserDaily },
    ]);
    if (siteFull) return '全站今日中转转发额度已用尽';
    if (!userFull) return '';
  }
  return '今日中转转发额度已用尽';
}

/**
 * 原生收件与站内互投使用同一归属偏好、限额及环路保护。
 * 每个目标先占域名与目标两个日计数（已满不再累加），再试原生 forward()；原生失败才走中转并占中转额度。
 */
export async function forwardReceivedMail(
  env: Env,
  mail: ForwardMail,
  owners: ForwardOwners,
  native?: ForwardableEmailMessage,
): Promise<void> {
  if (native?.headers.get('x-hpc-mail-relay') === await relayMarker(env)) return;
  const ownersByTarget = new Map<string, Set<number>>();
  for (const { userId, prefs } of await activeForwarders(env, mail.ownerIds, owners)) {
    for (const rawTarget of prefs.forward.addresses) {
      const target = normalizeEmail(rawTarget);
      if (!target || target === mail.toAddress) continue;
      ownersByTarget.set(target, (ownersByTarget.get(target) ?? new Set()).add(userId));
    }
  }
  const window = dayWindow();
  let quota: Promise<{ relayDaily: number; relayPerUserDaily: number }> | undefined;
  for (const [target, owned] of ownersByTarget) {
    const userIds = [...owned];
    let status: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let detail = '';
    let forwardMode: ForwardMode = '';
    let providerMessageId: string | null = null;
    try {
      const [domainFull, targetFull] = await reserveCounters(env, [
        { scope: 'fwd-domain', subject: mail.domain, window, limit: FORWARD_DOMAIN_DAILY_LIMIT },
        { scope: 'fwd-target', subject: target, window, limit: FORWARD_TARGET_DAILY_LIMIT },
      ]);
      if (domainFull || targetFull) {
        status = 'skipped';
        detail = '今日转发额度已用尽';
      } else {
        if (native) {
          try { await native.forward(target); forwardMode = 'native'; }
          catch { /* 未验证目标改用 Cloudflare 中转。 */ }
        }
        if (!forwardMode) {
          quota ??= getSettings(env).then((settings) => settings.quota);
          detail = await reserveRelay(env, window, userIds, await quota);
          if (detail) status = 'skipped';
          else {
            forwardMode = 'relay';
            providerMessageId = await relayForward(env, target, mail);
          }
        }
      }
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
      console.error(`转发到 ${target} 失败:`, error);
    }
    for (const userId of userIds) {
      try { await recordDeliveryResult(env, { userId, messageId: mail.messageId,
        channel: 'forward', target, status, error: detail, forwardMode }); }
      catch (error) { console.error('转发结果记录失败:', error); }
    }
    // 中转在 Cloudflare 侧的最终结果（退信等）经投递回执回写到上面的转发记录；原生 forward() 没有回执
    if (forwardMode === 'relay' && status === 'succeeded') {
      await saveDeliveryRefs(env, { kind: 'forward', messageId: mail.messageId, sender: `no-reply@${mail.domain}`,
        rfcMessageId: null, ownerIds: userIds, targets: [{ recipient: target, providerMessageId }] });
    }
  }
}
