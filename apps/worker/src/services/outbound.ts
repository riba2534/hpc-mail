import {
  EXTERNAL_MESSAGE_MAX_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type MessageSummary,
  type Role,
} from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, mailboxes, messages } from '../db/schema.js';
import {
  assertNoHeaderInjection,
  getEmailDomain,
  normalizeEmail,
} from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import { encodeBodyBase64, foldBase64, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { extractCodeByRegex } from './code-extract.js';
import { getRoutableDomains } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { resolveNotifyOwnerIds } from './mailbox.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { getSettings } from './setting.js';
import { sendNotifyWebhook } from './webhook-notify.js';
import { signAttachment } from '../lib/crypto.js';
import { attachmentKey, getExt, sha256Hex16 } from './storage.js';

/** 外发转链接的附件下载有效期：90 天（外部收件人无登录态，给长有效期） */
const EXTERNAL_LINK_TTL_SECONDS = 90 * 24 * 3600;

export interface Sender {
  userId: number;
  role: Role;
}

export interface DecodedAttachment {
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
  bytes: Uint8Array;
  /** base64 内容；仅 /v1 base64 内联那路自带，其余按需在组装 MIME 时现算（省一份常驻内存） */
  base64?: string;
}

/** sendMail 所需请求字段（base64 内联与 token 引用两种发送的共有子集） */
export interface SendMailInput {
  from: { mailboxId?: number; localPart?: string; domain?: string; displayName?: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  replyToMessageId?: number;
  forwardAttachmentsFrom?: number;
}

interface ResolvedFrom {
  address: string;
  domain: string;
  displayName: string;
}

/** 回复线程头：In-Reply-To / References */
interface ReplyContext {
  inReplyTo: string;
  references: string;
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 把 /v1 的 base64 内联附件解码为 DecodedAttachment[]（供 route 层调用） */
export function decodeInlineAttachments(
  atts: { filename: string; contentType: string; content: string }[],
): DecodedAttachment[] {
  return atts.map((a) => ({
    filename: a.filename,
    mimeType: a.contentType,
    contentId: '',
    disposition: 'attachment',
    bytes: decodeBase64(a.content),
    base64: a.content,
  }));
}

/** 外发配额计数类别（rate_counters.scope） */
const QUOTA_SCOPE_OUTBOUND = 'out';

/**
 * 外发日配额：仅普通用户 + 有站外收件人时生效（admin 豁免）。
 *
 * 先原子占额度再发送，全部失败时由 releaseOutboundQuota 回退——原先是 KV 上的
 * get→判断→发送→get→put，并发请求会读到同一个旧计数全部放行，防盗号群发的唯一闸门
 * 事实上不起作用。
 */
async function assertOutboundQuota(
  env: Env,
  quota: { dailyOutbound: number; dailyRecipients: number },
  sender: Sender,
  externalCount: number,
): Promise<void> {
  if (sender.role === 'admin') return;
  if (quota.dailyOutbound === 0 && quota.dailyRecipients === 0) return;
  const subject = String(sender.userId);
  const window = dayWindow();
  const cur = await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, subject, window, 1, externalCount);
  const overMails = quota.dailyOutbound > 0 && cur.count > quota.dailyOutbound;
  const overRecipients = quota.dailyRecipients > 0 && cur.units > quota.dailyRecipients;
  if (overMails || overRecipients) {
    // 拒绝的这次不该占额度，立即回退
    await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, subject, window, -1, -externalCount);
    throw new AppError(
      'rate_limited',
      overMails
        ? `已达每日外发上限（${quota.dailyOutbound} 封），请明日再试`
        : `已达每日外发收件人上限（${quota.dailyRecipients}）`,
    );
  }
}

/** 全部收件人都失败时把已占的额度还回去（不烧信誉的原有语义） */
async function releaseOutboundQuota(
  env: Env,
  quota: { dailyOutbound: number; dailyRecipients: number },
  sender: Sender,
  externalCount: number,
): Promise<void> {
  if (sender.role === 'admin') return;
  if (quota.dailyOutbound === 0 && quota.dailyRecipients === 0) return;
  await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, String(sender.userId), dayWindow(), -1, -externalCount);
}

async function resolveFrom(
  env: Env,
  sender: Sender,
  req: SendMailInput,
  domains: string[],
): Promise<ResolvedFrom> {
  const db = createDb(env);
  if (req.from.mailboxId !== undefined) {
    const box = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, req.from.mailboxId))
      .get();
    if (!box) throw new AppError('not_found', '发件邮箱不存在');
    if (sender.role !== 'admin' && box.userId !== sender.userId) {
      throw new AppError('forbidden', '无权使用该发件地址');
    }
    const displayName = (req.from.displayName || box.displayName || box.address.split('@')[0]!).trim();
    assertNoHeaderInjection(displayName);
    return { address: box.address, domain: box.domain, displayName };
  }

  const domain = req.from.domain!;
  const address = `${req.from.localPart!}@${domain}`;
  if (!domains.includes(domain)) {
    throw new AppError('validation_failed', '发件域名不在系统域名列表内');
  }
  if (sender.role !== 'admin') {
    const owned = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.address, address), eq(mailboxes.userId, sender.userId)))
      .get();
    if (!owned) throw new AppError('forbidden', '只能使用自己认领的地址发件');
  }
  const displayName = (req.from.displayName || req.from.localPart!).trim();
  assertNoHeaderInjection(displayName);
  return { address, domain, displayName };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 转发时把原邮件的附件带入本次发送：校验可见性后从 R2 读回，转成 DecodedAttachment */
async function loadForwardedAttachments(
  env: Env,
  db: Db,
  sender: Sender,
  sourceMessageId: number,
  alreadyCount: number,
): Promise<DecodedAttachment[]> {
  const source = await db.select().from(messages).where(eq(messages.id, sourceMessageId)).get();
  if (!source) return [];
  if (sender.role !== 'admin') {
    const owned = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.address, source.address), eq(mailboxes.userId, sender.userId)))
      .get();
    if (!owned) throw new AppError('forbidden', '无权转发该邮件的附件');
  }
  const rows = await db
    .select()
    .from(attachmentsTable)
    .where(eq(attachmentsTable.messageId, sourceMessageId))
    .all();
  const out: DecodedAttachment[] = [];
  for (const a of rows) {
    if (alreadyCount + out.length >= MAX_ATTACHMENTS) break;
    const obj = await env.r2.get(a.r2Key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    out.push({
      filename: a.filename,
      mimeType: a.mimeType,
      // 保留原始 contentId/disposition：此前硬编码成 ''/attachment，转发一封带内嵌图片的
      // 富文本邮件时，HTML 里的 <img src="cid:xxx"> 在 MIME 里再也找不到对应 part，
      // 收件端图片全裂、还平白多出一堆附件
      contentId: a.contentId,
      disposition: a.disposition,
      bytes,
    });
  }
  return out;
}

async function persistAttachments(
  env: Env,
  db: Db,
  messageId: number,
  atts: DecodedAttachment[],
): Promise<{ id: number; filename: string; size: number }[]> {
  if (!atts.length) return [];
  const rows = [];
  for (let seq = 0; seq < atts.length; seq++) {
    const att = atts[seq]!;
    const hash16 = await sha256Hex16(att.bytes);
    const key = attachmentKey(messageId, seq, hash16, getExt(att.filename));
    await env.r2.put(key, att.bytes, { httpMetadata: { contentType: att.mimeType } });
    rows.push({
      messageId,
      r2Key: key,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.bytes.byteLength,
      contentId: att.contentId,
      disposition: att.disposition,
    });
  }
  const inserted = await db
    .insert(attachmentsTable)
    .values(rows)
    .returning({
      id: attachmentsTable.id,
      filename: attachmentsTable.filename,
      size: attachmentsTable.size,
    });
  return inserted;
}

/** Cloudflare 原生发信（send_email binding），逐收件人发送 */
async function sendViaCloudflare(
  env: Env,
  from: ResolvedFrom,
  toAddr: string,
  req: SendMailInput,
  atts: DecodedAttachment[],
  reply: ReplyContext | null,
  text: string,
  html: string,
): Promise<void> {
  // 动态 import：`cloudflare:email` 在 vitest workerd 里静态加载会崩，
  // 且集成测试不发外部邮件，延迟到真实发送时才加载
  const [{ EmailMessage }, { createMimeMessage }] = await Promise.all([
    import('cloudflare:email'),
    import('mimetext/browser'),
  ]);
  const msg = createMimeMessage();
  msg.setSender({ name: from.displayName, addr: from.address });
  // 信封收件人是 toAddr（逐个发送），但头里要写完整的 To/Cc，否则每个收件人看到的都是
  // 「只发给我一个人」，既无法回复全部、也不知道这是群发；BCC 名单当然不写进头。
  // 站内互投那边存的是完整 {to, cc} 并在详情页展示，两边行为原本是不一致的
  msg.setRecipients(req.to.length ? req.to : [toAddr]);
  if (req.cc.length) msg.setCc(req.cc);
  msg.setSubject(req.subject);
  if (reply) {
    msg.setHeader('In-Reply-To', reply.inReplyTo);
    msg.setHeader('References', reply.references);
  }
  // base64 编码正文：见 encodeBodyBase64 的说明（7bit 原样输出会撞 998 字节行限）
  if (text) {
    msg.addMessage({
      contentType: 'text/plain',
      charset: 'UTF-8',
      encoding: 'base64',
      data: encodeBodyBase64(text),
    });
  }
  if (html) {
    msg.addMessage({
      contentType: 'text/html',
      charset: 'UTF-8',
      encoding: 'base64',
      data: encodeBodyBase64(html),
    });
  }
  for (const a of atts) {
    // 折行成 76 字符/行：不折行时整个附件是一整行，超 SMTP 998 字节行限会被下游 MTA 拒收。
    // filename/mimeType 走清洗：mimetext 是裸拼进头的，值里的引号/CRLF 会改写 part 头结构
    const inline = a.disposition === 'inline' && a.contentId;
    msg.addAttachment({
      filename: sanitizeFilename(a.filename),
      contentType: sanitizeMimeType(a.mimeType),
      data: foldBase64(a.base64 ?? bytesToBase64(a.bytes)),
      // 内联图片要带 Content-ID + inline，否则正文里的 <img src="cid:xxx"> 全裂、
      // 还会多出一堆莫名其妙的附件
      ...(inline ? { inline: true, headers: { 'Content-ID': `<${a.contentId}>` } } : {}),
    });
  }
  const message = new EmailMessage(from.address, toAddr, msg.asRaw());
  await env.email.send(message);
}

function summarize(
  row: typeof messages.$inferSelect,
  hasAttachments: boolean,
  isStarred: boolean,
): MessageSummary {
  return {
    id: row.id,
    direction: row.direction,
    address: row.address,
    domain: row.domain,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    subject: row.subject,
    preview: row.preview,
    verificationCode: row.verificationCode,
    status: row.status,
    errorDetail: row.errorDetail ?? '',
    recipientsTo: row.direction === 'outbound' ? (row.recipients?.to ?? []) : undefined,
    isRead: row.isRead,
    isStarred,
    hasAttachments,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 校验并构造回复线程头（回复的原邮件须对发件人可见） */
async function resolveReply(
  db: Db,
  sender: Sender,
  replyToMessageId: number | undefined,
): Promise<{ reply: ReplyContext | null; inReplyTo: string | null }> {
  if (!replyToMessageId) return { reply: null, inReplyTo: null };
  const orig = await db.select().from(messages).where(eq(messages.id, replyToMessageId)).get();
  if (!orig) return { reply: null, inReplyTo: null };
  if (sender.role !== 'admin') {
    const owned = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.address, orig.address), eq(mailboxes.userId, sender.userId)))
      .get();
    if (!owned) throw new AppError('forbidden', '无权回复该邮件');
  }
  if (!orig.messageId) return { reply: null, inReplyTo: null };
  const references = [orig.inReplyTo, orig.messageId].filter(Boolean).join(' ');
  return { reply: { inReplyTo: orig.messageId, references }, inReplyTo: orig.messageId };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'),
  );
}

interface AttachmentLink {
  filename: string;
  size: number;
  url: string;
}

/**
 * 把附件下载链接追加到正文末尾。
 * 只追加到「原本就存在」的 part：纯文本邮件（html 为空）绝不能凭空造出一个 html part，
 * 否则收件端（QQ/Gmail 等）与站内详情都优先渲染 html，正文会被只含链接的块整个盖掉。
 */
export function injectAttachmentLinks(
  text: string,
  html: string,
  links: AttachmentLink[],
): { text: string; html: string } {
  if (links.length === 0) return { text, html };
  const textBlock =
    `\n\n— 附件下载（链接有效期 90 天）—\n` +
    links.map((l) => `· ${l.filename} (${fmtBytes(l.size)}): ${l.url}`).join('\n');
  const htmlBlock =
    `<br><p>— 附件下载（<em>链接有效期 90 天</em>）—</p><ul>` +
    links.map((l) => `<li><a href="${l.url}">${escapeHtml(l.filename)}</a> (${fmtBytes(l.size)})</li>`).join('') +
    `</ul>`;
  return { text: text ? text + textBlock : '', html: html ? html + htmlBlock : '' };
}

/**
 * 决定外发邮件的实际负载：正文+附件 base64 ≤ 5MiB 时直发附件；超限则附件转下载链接
 * 注入正文、MIME 不带附件（绕过 send_email 5MiB 硬限）。返回最终正文与附件列表。
 */
async function buildExternalPayload(
  env: Env,
  origin: string,
  text: string,
  html: string,
  atts: DecodedAttachment[],
  attRows: { id: number; filename: string; size: number }[],
): Promise<{ text: string; html: string; atts: DecodedAttachment[] }> {
  const bodyBytes = new TextEncoder().encode(`${text}${html}`).length;
  const attBytes = atts.reduce((sum, a) => sum + Math.ceil((a.bytes.byteLength * 4) / 3), 0);
  if (bodyBytes + attBytes <= EXTERNAL_MESSAGE_MAX_BYTES || attRows.length === 0) {
    return { text, html, atts };
  }
  const links: AttachmentLink[] = [];
  for (const r of attRows) {
    const { exp, sig } = await signAttachment(env.jwt_secret, r.id, EXTERNAL_LINK_TTL_SECONDS);
    links.push({
      filename: r.filename,
      size: r.size,
      url: `${origin}/api/attachments/${r.id}?exp=${exp}&sig=${sig}`,
    });
  }
  const injected = injectAttachmentLinks(text, html, links);
  return { text: injected.text, html: injected.html, atts: [] };
}

/** 发件链路：身份校验 → 站外 Cloudflare send_email（超大附件转下载链接）/ 站内落库 → outbound 行落库 */
export async function sendMail(
  env: Env,
  ctx: ExecCtx,
  sender: Sender,
  req: SendMailInput,
  attachments: DecodedAttachment[],
  origin: string,
): Promise<MessageSummary> {
  assertNoHeaderInjection(req.subject);
  const settings = await getSettings(env);
  const db = createDb(env);
  const domains = await getRoutableDomains(env, settings);
  const from = await resolveFrom(env, sender, req, domains);

  // 转发携带原附件：从来源邮件读回（校验可见性），追加到本次发送
  if (req.forwardAttachmentsFrom) {
    const forwarded = await loadForwardedAttachments(
      env,
      db,
      sender,
      req.forwardAttachmentsFrom,
      attachments.length,
    );
    attachments = [...attachments, ...forwarded];
  }

  // 附件总量/数量统一在此兜底：base64 内联那路 schema 已校验体积，token 引用那路只查得到
  // 个数，而转发还会再追加——只有在三者合并后校验才不会漏（此前这段只写在转发分支内，
  // 不带转发的请求完全不查，10 个 token × 单文件上限即可远超合计上限）
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new AppError('validation_failed', `附件最多 ${MAX_ATTACHMENTS} 个`);
  }
  const totalAttachmentBytes = attachments.reduce((sum, a) => sum + a.bytes.byteLength, 0);
  if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError(
      'payload_too_large',
      `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
    );
  }

  const allRecipients = [...req.to, ...req.cc, ...req.bcc].map(normalizeEmail);
  const isInternal = (addr: string) => domains.includes(getEmailDomain(addr));
  const externalTargets = [...new Set(allRecipients.filter((a) => !isInternal(a)))];
  const internalTargets = [...new Set(allRecipients.filter(isInternal))];
  const hasExternal = externalTargets.length > 0;

  const { reply, inReplyTo } = await resolveReply(db, sender, req.replyToMessageId);

  const text = req.text ?? '';
  const html = req.html ?? '';
  const preview = makePreview(text, html);
  const size = new TextEncoder().encode(text + html).length;
  const code = settings.code_extract.enabled ? extractCodeByRegex(req.subject, text) : '';

  const sendChannel = hasExternal ? 'cloudflare' : 'internal';

  // 外发日配额必须在落库**之前**校验：放在落库之后的话，被限流时异常直接冒泡出去，
  // 而状态回填在更后面够不着，于是每限流一次就多留一封 status=sent 的「幽灵已发送」
  if (hasExternal) {
    await assertOutboundQuota(env, settings.quota, sender, externalTargets.length);
  }

  // outbound 行落库（status 占位）：拿到 id 后持久化附件，再决定外发正文/附件。
  // 外发超大附件需转为下载链接注入正文，而链接要附件 id、附件 id 要 message id。
  const outbound = await db
    .insert(messages)
    .values({
      direction: 'outbound',
      address: from.address,
      domain: from.domain,
      fromAddress: from.address,
      fromName: from.displayName,
      recipients: { to: req.to, cc: req.cc, bcc: req.bcc },
      subject: req.subject,
      preview,
      bodyText: text,
      bodyHtml: html,
      verificationCode: code,
      inReplyTo,
      status: hasExternal ? 'sent' : 'delivered',
      sendChannel,
      errorDetail: '',
      isRead: true,
      size,
      createdAt: new Date(),
    })
    .returning()
    .get();
  let status = hasExternal ? 'sent' : 'delivered';
  let errorDetail = '';
  let bodyText = text;
  let bodyHtml = html;
  try {
    // 附件持久化到 outbound 行（发件人「已发送」可见、可下载）
    const outboundAtts = await persistAttachments(env, db, outbound!.id, attachments);
    if (hasExternal) {
      // 外发负载：正文+附件 ≤ 阈值直发附件；超限则附件转下载链接注入正文，MIME 不带附件
      const payload = await buildExternalPayload(env, origin, text, html, attachments, outboundAtts);
      const failures: string[] = [];
      for (const addr of externalTargets) {
        try {
          await sendViaCloudflare(env, from, addr, req, payload.atts, reply, payload.text, payload.html);
        } catch (cfErr) {
          const cfMsg = cfErr instanceof Error ? cfErr.message : String(cfErr);
          failures.push(`${addr}: ${cfMsg}`);
        }
      }
      if (failures.length === externalTargets.length) {
        status = 'failed';
        errorDetail = failures.join('; ');
      } else if (failures.length) {
        status = 'sent';
        errorDetail = `部分收件人失败: ${failures.join('; ')}`;
      }
      // 外发实际正文（可能含链接）回填，让发件人「已发送」看到真实发出内容
      bodyText = payload.text;
      bodyHtml = payload.html;
    }
  } catch (e) {
    // 落库之后的任何步骤抛错（附件写 R2、链接签名等）都要把这一行标成 failed，
    // 否则留下的是一封永不回滚、状态却是「已发送」的假记录
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(messages)
      .set({ status: 'failed', errorDetail: msg })
      .where(eq(messages.id, outbound!.id));
    throw e;
  }

  // 额度在发送前已原子占用；全部收件人失败时还回去（全失败不烧信誉，不计数）
  if (hasExternal && status === 'failed') {
    await releaseOutboundQuota(env, settings.quota, sender, externalTargets.length);
  }

  // 站内互投：逐地址构造 inbound 行（含提码），同步落库保证即时可见。
  // 必须放在「外发失败即 throw」之前——站内投递是纯 D1 insert，不该被站外链路失败连坐
  const internalRows: number[] = [];
  for (const target of internalTargets) {
    const inbound = await db
      .insert(messages)
      .values({
        direction: 'inbound',
        address: target,
        domain: getEmailDomain(target),
        fromAddress: from.address,
        fromName: from.displayName,
        // BCC 名单不写入收件方记录：密送收件人的副本不应暴露其他被密送者
        recipients: { to: req.to, cc: req.cc, bcc: [] },
        subject: req.subject,
        preview,
        bodyText: text,
        bodyHtml: html,
        verificationCode: code,
        inReplyTo,
        status: 'received',
        sendChannel: 'internal',
        isRead: false,
        size,
        createdAt: new Date(),
      })
      .returning({ id: messages.id })
      .get();
    internalRows.push(inbound!.id);
    await persistAttachments(env, db, inbound!.id, attachments);
  }

  // 站外全失败但有站内收件人：整封不算失败，站内那份已经送到，站外失败只体现在 errorDetail
  if (status === 'failed' && internalTargets.length > 0) {
    status = 'sent';
    errorDetail = `站外收件人全部失败: ${errorDetail}`;
  }

  // 回填 outbound 状态与（外发）正文
  await db
    .update(messages)
    .set({ status, errorDetail, bodyText, bodyHtml })
    .where(eq(messages.id, outbound!.id));

  // 一个收件人都没送达才算整封失败
  if (status === 'failed') {
    throw new AppError('internal', errorDetail || '发送失败');
  }

  // 站内互投通知（异步）：按每个收件地址所属用户的个人偏好推送飞书 + 通用 webhook
  if (internalTargets.length) {
    ctx.waitUntil(
      (async () => {
        for (let i = 0; i < internalTargets.length; i++) {
          const target = internalTargets[i]!;
          const messageId = internalRows[i]!;
          const ownerIds = await resolveNotifyOwnerIds(env, target);
          for (const id of ownerIds) {
            const prefs = await getUserNotifyPrefs(env, id);
            try {
              await sendFeishuNotification(prefs.feishu, {
                subject: req.subject,
                fromAddress: from.address,
                fromName: from.displayName,
                toAddress: target,
                code,
                body: text || html,
              });
            } catch (e) {
              console.error('站内互投飞书通知失败:', e);
            }
            try {
              await sendNotifyWebhook(prefs.webhook, {
                event: 'mail.received',
                message: {
                  id: messageId,
                  address: target,
                  fromAddress: from.address,
                  fromName: from.displayName,
                  subject: req.subject,
                  verificationCode: code,
                  preview,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch (e) {
              console.error('站内互投通用 webhook 失败:', e);
            }
          }
        }
      })(),
    );
  }

  return summarize({ ...outbound!, status, errorDetail }, attachments.length > 0, false);
}
