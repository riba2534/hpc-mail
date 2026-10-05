import {
  EXTERNAL_MESSAGE_MAX_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type RecipientOutcome,
  type MessageSummary,
  type Role,
} from '@hpc-mail/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, deliveryObjectLeases, idempotencyRecords, mailboxes, messages, storageCleanupJobs } from '../db/schema.js';
import {
  assertNoHeaderInjection,
  getEmailDomain,
  normalizeEmail,
} from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import { encodeBodyBase64, foldBase64, foldMimeHeaders, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { extractCodeByRegex } from './code-extract.js';
import { getRoutableDomains } from './domain.js';
import { resolveNotifyOwnerIds } from './mailbox.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { getSettings } from './setting.js';
import { attachmentKey, getExt, sha256Hex16 } from './storage.js';
import { assertSendBodySize, bodyBytes, storeMailBody } from './mail-body.js';
import { forwardReceivedMail } from './forwarding.js';
import { enqueueMailNotifications, processNotificationJobs } from './notification-jobs.js';
import { retainExternalAttachments } from './external-attachment.js';
import type { IdempotencyHandle } from './idempotency.js';
import { injectAttachmentLinks, type AttachmentLink } from './attachment-links.js';
export { injectAttachmentLinks } from './attachment-links.js';

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
  /** 来源详情把 CID 替换成本站下载 URL；重发时据此恢复 MIME 内联引用。 */
  sourceAttachmentId?: number;
}

/** D1 写入结果不明时也只登记清理；任务执行前检查活引用，不能直接擦除可能已提交的对象。 */
async function queueObjectCleanup(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try { await createDb(env).insert(storageCleanupJobs).values(keys.map(r2Key => ({ r2Key }))).onConflictDoNothing(); }
  catch (error) { console.error('发件对象清理登记失败:', error); }
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
  let decoded: string;
  try { decoded = atob(b64); }
  catch { throw new AppError('validation_failed', '附件需为合法 base64'); }
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
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
  recipientCount: number,
): Promise<void> {
  if (sender.role === 'admin') return;
  if (quota.dailyOutbound === 0 && quota.dailyRecipients === 0) return;
  const subject = String(sender.userId);
  const window = dayWindow();
  const cur = await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, subject, window, 1, recipientCount);
  const overMails = quota.dailyOutbound > 0 && cur.count > quota.dailyOutbound;
  const overRecipients = quota.dailyRecipients > 0 && cur.units > quota.dailyRecipients;
  if (overMails || overRecipients) {
    // 拒绝的这次不该占额度，立即回退
    await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, subject, window, -1, -recipientCount);
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
  recipientCount: number,
): Promise<void> {
  if (sender.role === 'admin') return;
  if (quota.dailyOutbound === 0 && quota.dailyRecipients === 0) return;
  await bumpCounter(env, QUOTA_SCOPE_OUTBOUND, String(sender.userId), dayWindow(), -1, -recipientCount);
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
  alreadyBytes: number,
): Promise<DecodedAttachment[]> {
  const source = await db.select().from(messages).where(eq(messages.id, sourceMessageId)).get();
  if (!source) throw new AppError('not_found', '转发来源邮件不存在');
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
  if (alreadyCount + rows.length > MAX_ATTACHMENTS) {
    throw new AppError('validation_failed', `原邮件附件与新增附件合计最多 ${MAX_ATTACHMENTS} 个，请先移除部分附件`);
  }
  if (alreadyBytes + rows.reduce((sum, row) => sum + row.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError('payload_too_large', '原邮件附件与新增附件合计超过大小上限');
  }
  const out: DecodedAttachment[] = [];
  for (const a of rows) {
    const obj = await env.r2.get(a.r2Key);
    if (!obj) throw new AppError('not_found', `附件「${a.filename}」已丢失，无法完整转发`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    out.push({
      filename: a.filename,
      mimeType: a.mimeType,
      // 保留原始 contentId/disposition：此前硬编码成 ''/attachment，转发一封带内嵌图片的
      // 富文本邮件时，HTML 里的 <img src="cid:xxx"> 在 MIME 里再也找不到对应 part，
      // 收件端图片全裂、还平白多出一堆附件
      contentId: a.contentId,
      disposition: a.disposition,
      sourceAttachmentId: a.id,
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
  leaseToken: string,
): Promise<{
  id: number;
  r2Key: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string;
  disposition: string;
}[]> {
  if (!atts.length) return [];
  const rows = [];
  const uploadedKeys: string[] = [];
  try {
    for (let seq = 0; seq < atts.length; seq++) {
      const att = atts[seq]!;
      const hash16 = await sha256Hex16(att.bytes);
      const key = attachmentKey(messageId, seq, hash16, getExt(att.filename));
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
    // 先为全部对象登记发送中的独立引用。发件记录被 purge/release 删除时，清理仍须等待投递结束。
    await db.insert(deliveryObjectLeases).values(rows.map(row => ({
      r2Key: row.r2Key, token: leaseToken, expiresAt: new Date(Date.now() + 3600_000),
    })));
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      await env.r2.put(row.r2Key, atts[index]!.bytes, { httpMetadata: { contentType: row.mimeType } });
      uploadedKeys.push(row.r2Key);
    }
    return await db
      .insert(attachmentsTable)
      .values(rows)
      .returning({
        id: attachmentsTable.id,
        r2Key: attachmentsTable.r2Key,
        filename: attachmentsTable.filename,
        mimeType: attachmentsTable.mimeType,
        size: attachmentsTable.size,
        contentId: attachmentsTable.contentId,
        disposition: attachmentsTable.disposition,
      });
  } catch (error) {
    await queueObjectCleanup(env, uploadedKeys);
    throw error;
  }
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
  messageId: string,
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
  msg.setHeader('Message-ID', messageId);
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
  const message = new EmailMessage(from.address, toAddr, foldMimeHeaders(msg.asRaw()));
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
    recipientOutcomes: row.direction === 'outbound' ? row.recipientOutcomes : undefined,
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
): Promise<{ reply: ReplyContext | null; inReplyTo: string | null; references: string }> {
  if (!replyToMessageId) return { reply: null, inReplyTo: null, references: '' };
  const orig = await db.select().from(messages).where(eq(messages.id, replyToMessageId)).get();
  if (!orig) return { reply: null, inReplyTo: null, references: '' };
  if (sender.role !== 'admin') {
    const owned = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.address, orig.address), eq(mailboxes.userId, sender.userId)))
      .get();
    if (!owned) throw new AppError('forbidden', '无权回复该邮件');
  }
  if (!orig.messageId) return { reply: null, inReplyTo: null, references: '' };
  const references = [...new Set([orig.references, orig.inReplyTo, orig.messageId]
    .filter(Boolean).flatMap(value => value!.match(/<[^<>\s]+>/g) ?? []))].join(' ');
  assertNoHeaderInjection(orig.messageId);
  return { reply: { inReplyTo: orig.messageId, references }, inReplyTo: orig.messageId, references };
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
  attRows: { id: number; r2Key: string; filename: string; mimeType: string; size: number; contentId: string }[],
): Promise<{ text: string; html: string; atts: DecodedAttachment[] }> {
  const encodedBytes = Math.ceil(bodyBytes(text, html) * 1.38) +
    atts.reduce((sum, a) => sum + Math.ceil(a.bytes.byteLength * 1.38), 0);
  if (encodedBytes <= EXTERNAL_MESSAGE_MAX_BYTES || attRows.length === 0) {
    return { text, html, atts };
  }
  const links: AttachmentLink[] = [];
  const retained = await retainExternalAttachments(env, attRows, env.site_origin ?? origin);
  for (const r of attRows) {
    links.push({
      filename: r.filename,
      size: r.size,
      url: retained.get(r.id)!,
      contentId: r.contentId,
    });
  }
  const injected = injectAttachmentLinks(text, html, links);
  return { text: injected.text, html: injected.html, atts: [] };
}

/** 先持久化内容与幂等绑定，再投递；已确认投递的副作用不因状态回填故障重投。 */
export async function sendMail(
  env: Env,
  ctx: ExecCtx,
  sender: Sender,
  req: SendMailInput,
  attachments: DecodedAttachment[],
  origin: string,
  handle?: IdempotencyHandle | null,
): Promise<MessageSummary> {
  assertNoHeaderInjection(req.subject);
  const text = req.text ?? '';
  let html = req.html ?? '';
  assertSendBodySize(text, html);
  const settings = await getSettings(env);
  const db = createDb(env);
  const domains = await getRoutableDomains(env, settings);
  const from = await resolveFrom(env, sender, req, domains);
  if (req.forwardAttachmentsFrom) {
    const forwarded = await loadForwardedAttachments(env, db, sender, req.forwardAttachmentsFrom,
      attachments.length, attachments.reduce((sum, att) => sum + att.bytes.byteLength, 0));
    attachments = [...attachments, ...forwarded];
    const sourceCids = new Map(forwarded.filter(attachment => attachment.disposition === 'inline' && attachment.contentId)
      .map(attachment => [attachment.sourceAttachmentId!, attachment.contentId]));
    const siteOrigin = env.site_origin ?? origin;
    html = html.replace(/(?:https?:\/\/[^/\s"'<>]+)?\/api\/attachments\/(\d+)(?:\?[^\s"'<>]*)?/gi,
      (original, id: string) => {
        const cid = sourceCids.get(Number(id));
        if (!cid || new URL(original, siteOrigin).origin !== new URL(siteOrigin).origin) return original;
        return `cid:${cid}`;
      });
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new AppError('validation_failed', `附件最多 ${MAX_ATTACHMENTS} 个`);
  }
  const totalAttachmentBytes = attachments.reduce((sum, att) => sum + att.bytes.byteLength, 0);
  if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError('payload_too_large', '附件合计超过大小上限');
  }
  const recipients = {
    to: [...new Set(req.to.map(normalizeEmail))],
    cc: [...new Set(req.cc.map(normalizeEmail))],
    bcc: [...new Set(req.bcc.map(normalizeEmail))],
  };
  req = { ...req, ...recipients };
  const uniqueTargets = [...new Set([...recipients.to, ...recipients.cc, ...recipients.bcc])];
  const externalTargets = uniqueTargets.filter(address => !domains.includes(getEmailDomain(address)));
  const internalTargets = uniqueTargets.filter(address => domains.includes(getEmailDomain(address)));
  const { reply, inReplyTo, references } = await resolveReply(db, sender, req.replyToMessageId);
  const outgoingMessageId = `<${crypto.randomUUID()}@${from.domain}>`;
  const preview = makePreview(text, html);
  const size = bodyBytes(text, html) + totalAttachmentBytes;
  const code = settings.code_extract.enabled ? extractCodeByRegex(req.subject, text) : '';
  await assertOutboundQuota(env, settings.quota, sender, uniqueTargets.length);

  let outbound: typeof messages.$inferSelect | undefined;
  let storedBody: Awaited<ReturnType<typeof storeMailBody>> | undefined;
  try {
    storedBody = await storeMailBody(env, text, html);
    outbound = await db.insert(messages).values({
      direction: 'outbound', address: from.address, domain: from.domain,
      fromAddress: from.address, fromName: from.displayName, recipients,
      replyTo: [], subject: req.subject, preview, ...storedBody,
      verificationCode: code, messageId: outgoingMessageId, inReplyTo, references,
      status: 'pending', sendChannel: externalTargets.length ? 'cloudflare' : 'internal',
      errorDetail: '', isRead: true, size, createdAt: new Date(),
    }).returning().get();
    if (!outbound) throw new AppError('internal', '发送记录创建失败');
    if (handle) {
      const bound = await db.update(idempotencyRecords)
        .set({ messageId: outbound.id, updatedAt: new Date() })
        .where(and(
          eq(idempotencyRecords.actorType, handle.actor.type), eq(idempotencyRecords.actorId, handle.actor.id),
          eq(idempotencyRecords.key, handle.key), eq(idempotencyRecords.requestHash, handle.requestHash),
          eq(idempotencyRecords.status, 'pending'),
        )).returning({ messageId: idempotencyRecords.messageId }).get();
      if (!bound) throw new AppError('conflict', '发送幂等状态已变化，请查询发送记录');
    }
  } catch (error) {
    await releaseOutboundQuota(env, settings.quota, sender, uniqueTargets.length);
    if (!outbound && storedBody?.bodyR2Key) await queueObjectCleanup(env, [storedBody.bodyR2Key]);
    throw error;
  }

  const outcomes: RecipientOutcome[] = [];
  const internalDeliveries: { target: string; messageId: number; ownerIds: number[] }[] = [];
  let processingError = '';
  let outboundAtts: Awaited<ReturnType<typeof persistAttachments>> = [];
  const objectLeaseToken = crypto.randomUUID();
  try {
    outboundAtts = await persistAttachments(env, db, outbound.id, attachments, objectLeaseToken);
    if (externalTargets.length) {
      const payload = await buildExternalPayload(env, origin, text, html, attachments, outboundAtts);
      // 展示正文必须在首次外发前保存，发送成功后不再依赖正文持久化。
      if (payload.text !== text || payload.html !== html) {
        const originalKey = storedBody!.bodyR2Key;
        const actualBody = await storeMailBody(env, payload.text, payload.html);
        const updateBody = db.update(messages).set(actualBody).where(eq(messages.id, outbound.id));
        if (originalKey) await db.batch([
          db.insert(storageCleanupJobs).values({ r2Key: originalKey }).onConflictDoNothing(), updateBody,
        ]);
        else await updateBody;
        storedBody = actualBody;
      }
      for (const target of externalTargets) {
        try {
          await sendViaCloudflare(env, from, target, req, payload.atts, reply,
            payload.text, payload.html, outgoingMessageId);
          outcomes.push({ address: target, status: 'sent' });
        } catch (error) {
          outcomes.push({ address: target, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    for (const target of internalTargets) {
      let body: Awaited<ReturnType<typeof storeMailBody>> | undefined;
      let incoming: { id: number } | undefined;
      let ownerIds: number[] = [];
      try {
        // 每封站内副本独立持有正文对象，删除一封副本不会擦除其他收件人的正文。
        body = await storeMailBody(env, text, html);
        ownerIds = await resolveNotifyOwnerIds(env, target);
        const insertMessage = db.insert(messages).values({
          direction: 'inbound', address: target, domain: getEmailDomain(target),
          fromAddress: from.address, fromName: from.displayName,
          recipients: { to: recipients.to, cc: recipients.cc, bcc: [] }, replyTo: [],
          notifyOwnerIds: ownerIds,
          subject: req.subject, preview, ...body, verificationCode: code,
          messageId: outgoingMessageId, inReplyTo, references, status: 'received',
          sendChannel: 'internal', isRead: false, size, createdAt: new Date(),
        }).returning({ id: messages.id });
        if (outboundAtts.length) {
          // D1 batch 是事务：附件引用失败时收件副本也回滚，不能把缺附件的邮件报成已送达。
          const [inserted] = await db.batch([insertMessage,
            db.insert(attachmentsTable).values(outboundAtts.map(att => ({
              messageId: sql`(select id from messages where address = ${target} and message_id = ${outgoingMessageId} and direction = 'inbound' order by id desc limit 1)`,
              r2Key: att.r2Key, filename: att.filename, mimeType: att.mimeType,
              size: att.size, contentId: att.contentId, disposition: att.disposition,
            }))),
          ]);
          incoming = inserted[0];
        } else incoming = await insertMessage.get();
        if (!incoming) throw new Error('站内收件落库未返回 id');
      } catch (error) {
        if (!incoming && body?.bodyR2Key) await queueObjectCleanup(env, [body.bodyR2Key]);
        outcomes.push({ address: target, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // 正文与全部附件引用已原子落库，后续状态回填失败不改变已投递的事实。
      outcomes.push({ address: target, status: 'delivered' });
      internalDeliveries.push({ target, messageId: incoming.id, ownerIds });
    }
  } catch (error) {
    processingError = error instanceof Error ? error.message : String(error);
  } finally {
    if (attachments.length) {
      try {
        // purge 可在附件元数据插入前删除发件记录；清除这种晚插入的孤儿行，避免永久阻塞对象回收。
        await db.batch([
          db.insert(storageCleanupJobs).select(db.select({ r2Key: deliveryObjectLeases.r2Key,
            createdAt: sql<Date>`${Date.now()}`.as('created_at'), lastError: sql<string>`''`.as('last_error') })
            .from(deliveryObjectLeases).where(eq(deliveryObjectLeases.token, objectLeaseToken))).onConflictDoNothing(),
          db.delete(attachmentsTable).where(and(eq(attachmentsTable.messageId, outbound.id),
            sql`not exists (select 1 from messages where id = ${outbound.id})`)),
          db.delete(deliveryObjectLeases).where(eq(deliveryObjectLeases.token, objectLeaseToken)),
        ]);
      } catch (error) {
        // 暂时保持引用，cron 在租约到期后恢复回收；投递已完成的邮件不能因此改报失败。
        console.error('发送中附件引用释放延迟:', error);
      }
    }
  }
  const attempted = new Set(outcomes.map(outcome => outcome.address));
  for (const target of uniqueTargets) {
    if (!attempted.has(target)) outcomes.push({ address: target, status: 'failed', error: processingError || '投递未执行' });
  }
  const delivered = outcomes.filter(outcome => outcome.status !== 'failed');
  const status = delivered.length ? (delivered.some(outcome => outcome.status === 'sent') ? 'sent' : 'delivered') : 'failed';
  const errors = outcomes.filter(outcome => outcome.error).map(outcome => `${outcome.address}: ${outcome.error}`);
  const errorDetail = errors.length ? `部分收件人失败: ${errors.join('; ')}` : '';
  // 至少重试一次本地结果回填；两次皆失败时保留 pending 幂等占位，禁止再次外发。
  let saved = false;
  for (let attempt = 0; attempt < 2 && !saved; attempt++) {
    try {
      await db.update(messages).set({ status, errorDetail, recipientOutcomes: outcomes })
        .where(eq(messages.id, outbound.id));
      saved = true;
    } catch (error) { console.error('投递结果回填失败:', error); }
  }
  if (!delivered.length) {
    await releaseOutboundQuota(env, settings.quota, sender, uniqueTargets.length);
    throw new AppError('internal', errorDetail || processingError || '发送失败');
  }

  // 站内收件与 SMTP 收件统一转发及通知；每次发送只启动一组有界通知处理器。
  if (internalDeliveries.length) ctx.waitUntil((async () => {
    const forwarding: Promise<void>[] = [];
    for (const delivery of internalDeliveries) {
      try {
        const ownerIds = delivery.ownerIds;
        forwarding.push(Promise.all(ownerIds.map(id => getUserNotifyPrefs(env, id))).then(prefs => forwardReceivedMail(env, {
          messageId: delivery.messageId, ownerIds,
          fromAddress: from.address, fromName: from.displayName, toAddress: delivery.target,
          domain: getEmailDomain(delivery.target), subject: req.subject, text, html, replyTo: [],
          attachments: attachments.map(att => ({ ...att, content: att.bytes })),
        }, prefs)).catch(error => console.error('站内转发失败:', error)));
        await enqueueMailNotifications(env, null, {
          ownerIds, message: { id: delivery.messageId, address: delivery.target,
            fromAddress: from.address, fromName: from.displayName, subject: req.subject,
            verificationCode: code, preview, createdAt: new Date().toISOString() }, text, html,
        });
      } catch (error) { console.error('站内转发/通知入队失败:', error); }
    }
    await Promise.all([processNotificationJobs(env, { limit: 8, concurrency: 4 }), ...forwarding]);
  })());
  return summarize({ ...outbound, ...storedBody!, status, errorDetail, recipientOutcomes: outcomes }, attachments.length > 0, false);
}
