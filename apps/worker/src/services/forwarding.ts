import {
  EXTERNAL_MESSAGE_MAX_BYTES, emailAddressSchema, isSafeInlineImageType, normalizeMimeType,
  protectMailText, type Settings,
} from '@hpc-mail/shared';
import { and, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { notificationJobs } from '../db/schema.js';
import { deriveSubkey, hmacSha256Base64 } from '../lib/crypto.js';
import { getEmailDomain, normalizeEmail } from '../lib/email-address.js';
import { bytesToBase64, encodeBodyBase64, foldBase64, foldMimeHeaders, formatAddressHeader, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { isDefiniteSendRejection } from '../lib/send-rejection.js';
import { escapeHtml, type MailText } from '../lib/text.js';
import type { Env } from '../types.js';
import { deliveryEventsQueue, deliveryRefInserts } from './delivery-refs.js';
import { NOTIFY_OWNER_IDS_SQL } from './mailbox.js';
import { FORWARD_DOMAIN_DAILY_LIMIT, FORWARD_TARGET_DAILY_LIMIT } from './notification-jobs.js';
import { LEGACY_NOTIFY_KEYS, notifyOwnersFromRows, type NotifyOwner, type NotifyOwnerRawRow } from './notify-prefs.js';
import { protectMailBody, safeMailContentId } from './protected-mail.js';
import { dayWindow, releaseCounters, reserveCounters, type CounterLimit } from './rate-counter.js';
import { getSettings } from './setting.js';
import { lookupSuppressions, suppressedFor, suppressionMessage } from './suppression.js';

export interface ForwardAttachment {
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
}

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
  mailText?: MailText;
}

/** 中转信的防环头：用 jwt_secret 派生的中转子密钥计算 */
export async function relayMarker(env: Env): Promise<string> {
  return hmacSha256Base64(new TextEncoder().encode(await deriveSubkey(env.jwt_secret, 'relay')), 'hpc-mail-relay:v1');
}

/** 收到的信是否是本站中转出去的：新旧两种防环头都认（改用子密钥前发出、仍在投递途中的中转信） */
export async function isOwnRelay(env: Env, header: string | null | undefined): Promise<boolean> {
  if (!header) return false;
  if (header === await relayMarker(env)) return true;
  return header === await hmacSha256Base64(new TextEncoder().encode(env.jwt_secret), 'hpc-mail-relay:v1');
}

interface RelayAttachment extends ForwardAttachment {
  inlineId: string | null;
}

interface RelayBody {
  text: string;
  html: string;
  attachments: RelayAttachment[];
  reply: boolean;
}

function relayOrigin(env: Env): URL | null {
  if (!env.site_origin) return null;
  try {
    const url = new URL(env.site_origin);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function cleanTitle(value: string): string {
  const title = value.replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/(?:https?:\/\/|(?<![\w:])\/\/|\bwww\.)[^\s<>]+/gi, '（链接已省略）')
    .trim();
  return Array.from(title).slice(0, 240).join('') || '(无主题)';
}

function hasRasterSignature(attachment: ForwardAttachment): boolean {
  const bytes = attachment.content;
  const head = String.fromCharCode(...bytes.subarray(0, 32));
  switch (normalizeMimeType(attachment.mimeType)) {
    case 'image/png':
      return head.startsWith('\x89PNG\r\n\x1a\n');
    case 'image/jpeg':
      return head.startsWith('\xff\xd8\xff');
    case 'image/gif':
      return head.startsWith('GIF87a') || head.startsWith('GIF89a');
    case 'image/webp':
      return head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
    case 'image/avif':
      return head.slice(4, 8) === 'ftyp' && /(?:avif|avis)/.test(head.slice(8));
    default:
      return false;
  }
}

const RESTRICTED_ATTACHMENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/calendar']);

function relayAttachments(attachments: ForwardAttachment[]): RelayAttachment[] {
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const id = safeMailContentId(attachment.contentId);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return attachments.flatMap((attachment): RelayAttachment[] => {
    const type = normalizeMimeType(attachment.mimeType);
    if (/^(?:message|multipart)\//.test(type) || RESTRICTED_ATTACHMENT_TYPES.has(type)
      || /\.(?:eml|mht|mhtml|html?|xhtml|svg|svgz|ics)$/i.test(attachment.filename.trim())) return [];
    const id = safeMailContentId(attachment.contentId);
    const inlineId = id && counts.get(id) === 1 && attachment.disposition === 'inline'
      && isSafeInlineImageType(type) && hasRasterSignature(attachment) ? id : null;
    return [{ ...attachment, mimeType: inlineId ? type : attachment.mimeType, inlineId }];
  });
}

function relaySize(text: string, html: string, attachments: RelayAttachment[]): number {
  return Math.ceil(new TextEncoder().encode(text + html).byteLength * 1.38)
    + attachments.reduce((sum, attachment) => sum + Math.ceil(attachment.content.byteLength * 1.38), 0);
}

const readInMail = (link: string) => link ? `登录 HPC Mail 查看原信：${link}` : '请登录 HPC Mail 查看原信。';

function noticeBody(link: string): RelayBody {
  return { text: `HPC Mail 收到了一封新邮件。\n\n${readInMail(link)}`, html: '', attachments: [], reply: false };
}

/** 外部邮箱自己决定加载策略。正文净化发生在 MIME 组装前，大附件只提示去有权限的站内原信下载。 */
async function protectedBody(mail: ForwardMail, link: string): Promise<RelayBody> {
  let attachments = relayAttachments(mail.attachments);
  let body = await protectMailBody({
    text: mail.text,
    html: mail.html,
    inlineContentIds: attachments.flatMap((attachment) => attachment.inlineId ? [attachment.inlineId] : []),
  });
  if (relaySize(body.text, body.html, attachments) > EXTERNAL_MESSAGE_MAX_BYTES && attachments.length) {
    attachments = [];
    body = await protectMailBody({ text: mail.text, html: mail.html });
  }
  if (relaySize(body.text, body.html, attachments) > EXTERNAL_MESSAGE_MAX_BYTES) return noticeBody(link);
  const note = [
    ...(attachments.length < mail.attachments.length ? ['部分附件仅在 HPC Mail 可查看。'] : []),
  ];
  const meta = [
    `原始发件人：${protectMailText([mail.fromName, mail.fromAddress].filter(Boolean).join(' '))}`,
    `原收件地址：${mail.toAddress}`,
  ];
  return {
    text: [...meta, '', body.text, '', ...note, readInMail(link)].join('\n'),
    html: body.html ? `<p>${meta.map(escapeHtml).join('<br>')}</p>${body.html}<p>`
      + [...note.map(escapeHtml), link ? `<a href="${escapeHtml(link)}">登录 HPC Mail 查看原信</a>` : escapeHtml(readInMail(''))].join('<br>')
      + '</p>' : '',
    attachments, reply: true,
  };
}

async function relayMessage(env: Env, sender: string, target: string, mail: ForwardMail, body: RelayBody) {
  // 静态 import cloudflare:email 和 mimetext 会导致本地 workerd 加载失败。
  const [{ EmailMessage }, { createMimeMessage }] = await Promise.all([
    import('cloudflare:email'),
    import('mimetext/browser'),
  ]);
  const msg = createMimeMessage();
  msg.setSender({ name: 'HPC Mail 转发', addr: sender });
  msg.setRecipient(target);
  msg.setSubject(cleanTitle(mail.subject));
  const messageId = `<${crypto.randomUUID()}@${getEmailDomain(sender)}>`;
  msg.setHeader('Message-ID', messageId);
  msg.setHeader('X-HPC-Mail-Relay', await relayMarker(env));
  msg.setHeader('Auto-Submitted', 'auto-forwarded');
  msg.addMessage({ contentType: 'text/plain', charset: 'UTF-8', encoding: 'base64', data: encodeBodyBase64(body.text) });
  if (body.html) {
    msg.addMessage({ contentType: 'text/html', charset: 'UTF-8', encoding: 'base64', data: encodeBodyBase64(body.html) });
  }
  for (const attachment of body.attachments) {
    msg.addAttachment({
      filename: sanitizeFilename(attachment.filename),
      contentType: sanitizeMimeType(attachment.mimeType),
      data: foldBase64(bytesToBase64(attachment.content)),
      ...(attachment.inlineId ? { inline: true, headers: { 'Content-ID': `<${attachment.inlineId}>` } } : {}),
    });
  }
  const replies = body.reply ? (mail.replyTo.length ? mail.replyTo : [mail.fromAddress]).flatMap((address) => {
    const parsed = emailAddressSchema.safeParse(address);
    return parsed.success && !/[\x00-\x1f\x7f<>,()";:\\]/.test(parsed.data) ? [{ address: parsed.data, name: '' }] : [];
  }) : [];
  const replyHeader = replies.length ? formatAddressHeader('Reply-To', replies) + '\r\n' : '';
  const raw = foldMimeHeaders(replyHeader + msg.asRaw());
  if (new TextEncoder().encode(raw).byteLength > EXTERNAL_MESSAGE_MAX_BYTES) return null;
  return { message: new EmailMessage(sender, target, raw), messageId };
}

/** 中转转发的日计数：全站一格（subject `instance`），未认领地址的来信另共用一格（subject `unclaimed`），按天窗口 */
export const FORWARD_RELAY_SCOPE = 'fwd-relay';
/** 已认领地址的中转按归属人日计数（subject 为用户 id） */
export const FORWARD_RELAY_USER_SCOPE = 'fwd-relay-user';

interface Forwarders {
  list: Map<number, NotifyOwner>;
  unclaimed: boolean;
}

/** 发信前刷新归属与偏好。只允许收信时及现在都有权读取原信的用户转发该信。 */
async function loadForwarders(env: Env, mail: ForwardMail, owners: Map<number, NotifyOwner>): Promise<Forwarders> {
  const list = new Map<number, NotifyOwner>();
  if (![...owners.values()].some((owner) => owner.active && owner.prefs.forward.enabled && owner.prefs.forward.addresses.length)) {
    return { list, unclaimed: false };
  }
  const [result, legacy] = await env.db.batch([
    env.db.prepare(`SELECT id, status, role, notify_prefs,
      NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1) AS unclaimed
      FROM users WHERE status = 'active' AND id IN (${NOTIFY_OWNER_IDS_SQL})
      AND id IN (SELECT value FROM json_each(?2))`).bind(mail.toAddress, JSON.stringify(mail.ownerIds)),
    env.db.prepare('SELECT key, value FROM settings WHERE key IN (?1, ?2, ?3)').bind(...LEGACY_NOTIFY_KEYS),
  ]);
  const rows = result!.results as (NotifyOwnerRawRow & { unclaimed: number })[];
  return {
    list: notifyOwnersFromRows(rows, legacy!.results as { key: string; value: string }[]),
    unclaimed: rows[0]?.unclaimed === 1,
  };
}

type RelayQuota = Pick<Settings['quota'], 'relayDaily' | 'relayPerUserDaily' | 'relayUnclaimedDaily'>;

/** 认领地址的中转计入归属人限额，catch-all 的来信共享未认领额度。 */
async function reserveRelay(
  env: Env, window: number, forwarders: Forwarders, ownerId: number, quota: RelayQuota,
): Promise<{ skipped: string; taken: CounterLimit[] }> {
  const site: CounterLimit = { scope: FORWARD_RELAY_SCOPE, subject: 'instance', window, limit: quota.relayDaily };
  const own: CounterLimit = forwarders.unclaimed
    ? { scope: FORWARD_RELAY_SCOPE, subject: 'unclaimed', window, limit: quota.relayUnclaimedDaily }
    : { scope: FORWARD_RELAY_USER_SCOPE, subject: String(ownerId), window, limit: quota.relayPerUserDaily };
  const [siteFull, ownFull] = await reserveCounters(env, [site, own]);
  if (siteFull) return { skipped: '全站今日中转转发额度已用尽', taken: [] };
  if (ownFull) return { skipped: forwarders.unclaimed ? '未认领地址今日中转转发额度已用尽' : '今日中转转发额度已用尽', taken: [] };
  return { skipped: '', taken: [site, own] };
}

async function releaseQuota(env: Env, items: CounterLimit[]): Promise<void> {
  try {
    await releaseCounters(env, items);
  } catch {
    console.error('转发额度退还失败');
  }
}

interface TargetForward {
  userIds: number[];
  notice: boolean;
}

/** 在提交 SMTP 前原子占用整组。在进程中断后，现有通知巡检会把陈旧的 processing 标为 unknown。 */
async function claimForward(env: Env, mail: ForwardMail, target: string, policy: TargetForward) {
  const keyOf = (userId: number) => `mail:${mail.messageId}:${userId}:forward:${target}`;
  const now = Date.now();
  const result = await env.db.prepare(`WITH eligible AS MATERIALIZED (
      SELECT id, CASE WHEN json_valid(notify_prefs) THEN json_extract(notify_prefs, '$.forward.contentMode') END AS mode
      FROM users WHERE status = 'active' AND id IN (${NOTIFY_OWNER_IDS_SQL}) AND id IN (SELECT value FROM json_each(?5))
      AND CASE
        WHEN notify_prefs IS NULL THEN role = 'admin'
        WHEN json_valid(notify_prefs) THEN json_extract(notify_prefs, '$.forward.enabled') = 1
          AND EXISTS (
            SELECT 1 FROM json_each(notify_prefs, '$.forward.addresses')
            WHERE trim(lower(value)) = ?4
          )
        ELSE 0 END
      AND NOT EXISTS (
        SELECT 1 FROM notification_jobs WHERE dedupe_key IN (SELECT value FROM json_each(?6))
      )
    )
    INSERT INTO notification_jobs (
      message_id, user_id, channel, target, payload, status, attempts, max_attempts,
      next_attempt_at, created_at, updated_at, last_attempt_at, forward_mode, dedupe_key
    )
    SELECT ?3, id, 'forward', ?4, '{}', 'processing', 1, 1, ?2, ?2, ?2, ?2, 'relay',
      'mail:' || ?3 || ':' || id || ':forward:' || ?4 FROM eligible
    WHERE ?7 = 1 OR NOT EXISTS (SELECT 1 FROM eligible WHERE mode = 'notice')
    ON CONFLICT(dedupe_key) DO NOTHING RETURNING id, user_id`)
    .bind(mail.toAddress, now, mail.messageId, target, JSON.stringify(policy.userIds),
      JSON.stringify(mail.ownerIds.map(keyOf)), Number(policy.notice)).all<{ id: number; user_id: number }>();
  return result.results;
}

/** 收件、站内转发与所有目标邮箱均通过净化后的 MIME 中转。 */
export async function forwardReceivedMail(
  env: Env,
  mail: ForwardMail,
  owners: Map<number, NotifyOwner>,
  native?: ForwardableEmailMessage,
): Promise<void> {
  if (await isOwnRelay(env, native?.headers.get('x-hpc-mail-relay'))) return;
  const forwarders = await loadForwarders(env, mail, owners);
  const targets = new Map<string, TargetForward>();
  for (const [userId, owner] of forwarders.list) {
    if (!owner.active || !owner.prefs.forward.enabled) continue;
    for (const rawTarget of owner.prefs.forward.addresses) {
      const target = normalizeEmail(rawTarget);
      if (!target || target === normalizeEmail(mail.toAddress)) continue;
      const group = targets.get(target) ?? { userIds: [], notice: false };
      group.userIds.push(userId);
      group.notice ||= owner.prefs.forward.contentMode === 'notice';
      targets.set(target, group);
    }
  }
  if (!targets.size) return;

  const site = relayOrigin(env);
  const sender = `no-reply@${site?.hostname ?? mail.domain}`;
  const originalLink = site ? new URL(`/mail/${mail.messageId}`, site).href : '';
  const recordReceipts = deliveryEventsQueue(env) !== null;
  const quota = await getSettings(env).then((settings) => settings.quota);
  const blocked = recordReceipts
    ? suppressedFor(await lookupSuppressions(env, [...targets.keys()]), getEmailDomain(sender)) : null;
  const window = dayWindow();
  const db = createDb(env);
  let protectedCopy: Promise<RelayBody> | undefined;
  for (const [target, group] of targets) {
    let status: 'succeeded' | 'failed' | 'skipped' | 'unknown' = 'succeeded';
    let detail = '';
    let handedOver = false;
    let sent: { providerMessageId: string | null; rfcMessageId: string } | undefined;
    let takenLimits: CounterLimit[] = [];
    let takenRelay: CounterLimit[] = [];
    const claimed = await claimForward(env, mail, target, group).catch(() => {
      console.error('转发任务认领失败');
      return [];
    });
    if (!claimed.length) continue;
    try {
      const suppression = blocked?.get(target);
      if (suppression) {
        status = 'skipped';
        detail = suppressionMessage(suppression);
      } else {
        const limits: CounterLimit[] = [
          { scope: 'fwd-domain', subject: mail.domain, window, limit: FORWARD_DOMAIN_DAILY_LIMIT },
          { scope: 'fwd-target', subject: target, window, limit: FORWARD_TARGET_DAILY_LIMIT },
        ];
        const [domainFull, targetFull] = await reserveCounters(env, limits);
        if (domainFull || targetFull) {
          status = 'skipped';
          detail = '今日转发额度已用尽';
        } else {
          takenLimits = limits;
          const relay = await reserveRelay(env, window, forwarders, claimed[0]!.user_id, quota);
          if (relay.skipped) {
            status = 'skipped';
            detail = relay.skipped;
          } else {
            takenRelay = relay.taken;
            const body = group.notice ? noticeBody(originalLink)
              : await (protectedCopy ??= protectedBody(mail, originalLink).catch(() => noticeBody(originalLink)));
            const prepared = (await relayMessage(env, sender, target, mail, body))
              ?? (await relayMessage(env, sender, target, mail, noticeBody(originalLink)));
            if (!prepared) throw new Error('Safe forward exceeded MIME size limit');
            const email = env.email;
            if (!email) throw new Error('Email sending binding unavailable');
            handedOver = true;
            const result = await email.send(prepared.message);
            sent = { providerMessageId: result?.messageId ?? null, rfcMessageId: prepared.messageId };
          }
        }
      }
    } catch (error) {
      status = handedOver && !isDefiniteSendRejection(error) ? 'unknown' : 'failed';
      detail = status === 'unknown' ? '邮件服务返回的投递结果未确认'
        : handedOver ? '邮件服务拒绝了转发，请检查目标地址及发送额度' : '无法生成安全的转发邮件';
      console.error(JSON.stringify({ event: 'privacy_forward_failed', messageId: mail.messageId, status }));
    }
    if ((status === 'failed' || status === 'skipped') && takenRelay.length) await releaseQuota(env, takenRelay);
    if (!handedOver && takenLimits.length) await releaseQuota(env, takenLimits);

    try {
      const write = db.update(notificationJobs).set({
        status, lastError: detail, updatedAt: new Date(), forwardMode: handedOver ? 'relay' : '',
      }).where(and(sql`${notificationJobs.id} IN (SELECT value FROM json_each(${JSON.stringify(claimed.map((row) => row.id))}))`,
        inArray(notificationJobs.status, ['processing', 'unknown'])));
      if (recordReceipts && sent) {
        await db.batch([write, ...deliveryRefInserts(db, {
          kind: 'forward', messageId: mail.messageId, sender, rfcMessageId: sent.rfcMessageId,
          ownerIds: claimed.map((row) => row.user_id), targets: [{ recipient: target, providerMessageId: sent.providerMessageId }],
        })]);
      } else {
        await write;
      }
    } catch {
      console.error('转发结果记录失败');
    }
  }
}
