import { EXTERNAL_MESSAGE_MAX_BYTES, type Settings, type UserNotifyPrefs } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { deriveSubkey, hmacSha256Base64 } from '../lib/crypto.js';
import { chunk } from '../lib/d1.js';
import { normalizeEmail } from '../lib/email-address.js';
import { bytesToBase64, encodeBodyBase64, foldBase64, foldMimeHeaders, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { convertHtmlToText, type MailText } from '../lib/text.js';
import type { Env } from '../types.js';
import { dayWindow, releaseCounters, reserveCounters, type CounterLimit } from './rate-counter.js';
import { retainExternalAttachments } from './external-attachment.js';
import { injectAttachmentLinks } from './attachment-links.js';
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
  await env.email.send(new EmailMessage(sender, target, foldMimeHeaders(replyHeader + raw)));
}

/** 中转转发的日计数：全站一格（subject `instance`），未认领地址的来信另共用一格（subject `unclaimed`），按天窗口 */
export const FORWARD_RELAY_SCOPE = 'fwd-relay';
/** 已认领地址的中转按归属人日计数（subject 为用户 id） */
export const FORWARD_RELAY_USER_SCOPE = 'fwd-relay-user';

/** 转发归属人：收件链路传已读出的状态与偏好；站内互投只传偏好（与 mail.ownerIds 按下标对应），状态在这里补读 */
export type ForwardOwners = Map<number, NotifyOwner> | UserNotifyPrefs[];

interface Forwarders {
  list: { userId: number; prefs: UserNotifyPrefs }[];
  /** 来信时地址未被认领（归属人是全体管理员） */
  unclaimed: boolean;
}

/**
 * 开启转发且仍启用的归属人，以及来信时地址是否未认领。有人开启转发时才查库，一次 batch 读地址当前的认领人，
 * 只给偏好时同批补读归属人状态（在 waitUntil 里，不在收件 Ack 前）。已停用的归属人原生与中转都不转发。
 * 已认领地址的归属快照只有认领人一个；快照里有多人（全体管理员），或唯一那人不是当前认领人，按未认领计。
 */
async function loadForwarders(env: Env, mail: ForwardMail, owners: ForwardOwners): Promise<Forwarders> {
  const enabled = owners instanceof Map
    ? mail.ownerIds.flatMap((userId) => {
      const owner = owners.get(userId);
      return owner?.active && owner.prefs.forward.enabled ? [{ userId, prefs: owner.prefs }] : [];
    })
    : mail.ownerIds.flatMap((userId, index) => owners[index]?.forward.enabled ? [{ userId, prefs: owners[index]! }] : []);
  if (!enabled.length) return { list: [], unclaimed: false };
  const unverified = owners instanceof Map ? [] : [...new Set(enabled.map((item) => item.userId))];
  const [claim, ...statuses] = await env.db.batch<{ id: number }>([
    env.db.prepare('SELECT user_id AS id FROM mailboxes WHERE address = ?1').bind(mail.toAddress),
    ...chunk(unverified).map((ids) => env.db.prepare(`SELECT id FROM users WHERE status = 'active'
      AND id IN (${ids.map(() => '?').join(', ')})`).bind(...ids)),
  ]);
  const claimant = claim?.results[0]?.id;
  const unclaimed = !(mail.ownerIds.length === 1 && claimant !== undefined && Number(claimant) === mail.ownerIds[0]);
  if (owners instanceof Map) return { list: enabled, unclaimed };
  const active = new Set(statuses.flatMap((result) => result.results.map((row) => Number(row.id))));
  return { list: enabled.filter((item) => active.has(item.userId)), unclaimed };
}

type RelayQuota = Pick<Settings['quota'], 'relayDaily' | 'relayPerUserDaily' | 'relayUnclaimedDaily'>;

/**
 * 中转额度：全站一格，再加来信地址那一格——已认领地址计在认领人名下；未认领地址（归全体管理员）共用
 * `unclaimed` 一格：catch-all 谁都能灌信，不能按管理员人数叠加。返回跳过原因（有额度时为空串）
 * 与占到的格子（中转失败时退还）。
 */
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

/** 退还没用上的额度；退还失败只记日志，不改变这次转发的结果 */
async function releaseQuota(env: Env, items: CounterLimit[]): Promise<void> {
  try {
    await releaseCounters(env, items);
  } catch (error) {
    console.error('转发额度退还失败:', error);
  }
}

/**
 * 原生收件与站内互投使用同一归属偏好、限额及环路保护。
 * 每个目标先占域名与目标两个日计数（已满不再累加），再试原生 forward()；原生失败才走中转并占中转额度。
 * 中转因额度跳过时退还域名与目标计数（这次什么也没发出去）；中转抛错时退还中转额度。
 */
export async function forwardReceivedMail(
  env: Env,
  mail: ForwardMail,
  owners: ForwardOwners,
  native?: ForwardableEmailMessage,
): Promise<void> {
  if (await isOwnRelay(env, native?.headers.get('x-hpc-mail-relay'))) return;
  const forwarders = await loadForwarders(env, mail, owners);
  const ownersByTarget = new Map<string, Set<number>>();
  for (const { userId, prefs } of forwarders.list) {
    for (const rawTarget of prefs.forward.addresses) {
      const target = normalizeEmail(rawTarget);
      if (!target || target === mail.toAddress) continue;
      ownersByTarget.set(target, (ownersByTarget.get(target) ?? new Set()).add(userId));
    }
  }
  const window = dayWindow();
  let quota: Promise<RelayQuota> | undefined;
  for (const [target, owned] of ownersByTarget) {
    const userIds = [...owned];
    let status: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let detail = '';
    let forwardMode: ForwardMode = '';
    try {
      const limits: CounterLimit[] = [
        { scope: 'fwd-domain', subject: mail.domain, window, limit: FORWARD_DOMAIN_DAILY_LIMIT },
        { scope: 'fwd-target', subject: target, window, limit: FORWARD_TARGET_DAILY_LIMIT },
      ];
      const [domainFull, targetFull] = await reserveCounters(env, limits);
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
          const relay = await reserveRelay(env, window, forwarders, userIds[0]!, await quota);
          if (relay.skipped) {
            status = 'skipped';
            detail = relay.skipped;
            await releaseQuota(env, limits);
          } else {
            forwardMode = 'relay';
            try {
              await relayForward(env, target, mail);
            } catch (error) {
              await releaseQuota(env, relay.taken);
              throw error;
            }
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
  }
}
