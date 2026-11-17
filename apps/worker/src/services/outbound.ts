import {
  EXTERNAL_MESSAGE_MAX_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  OUTBOUND_DELIVERY_CONCURRENCY,
  type MailAddress,
  type RecipientOutcome,
  type MessageSummary,
  type Role,
  type SendFrom,
} from '@hpc-mail/shared';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { attachments as attachmentsTable, deliveryObjectLeases, mailboxes, messages, storageCleanupJobs } from '../db/schema.js';
import {
  assertNoHeaderInjection,
  getEmailDomain,
  normalizeEmail,
} from '../lib/email-address.js';
import { AppError, type AppErrorHints } from '../lib/errors.js';
import {
  base64ToBytes,
  bytesToBase64,
  encodeBodyBase64,
  encodeUnstructuredValue,
  foldBase64,
  foldMimeHeaders,
  formatAddressHeader,
  hasUnfoldableToken,
  MAX_HEADER_TOKEN_BYTES,
  sanitizeFilename,
  sanitizeMimeType,
} from '../lib/mime.js';
import { makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { extractCodeByRegex } from './code-extract.js';
import { extractVerificationLink } from './link-extract.js';
import { assertHostedSendable, getRoutableDomains } from './domain.js';
import { HOSTED_SEND_CLAIM_SQL, resolveDeliveryOwners } from './mailbox.js';
import { loadSourceMessage } from './message.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow, OUTBOUND_QUOTA_SCOPE } from './rate-counter.js';
import { getSettings } from './setting.js';
import { attachmentKey, getExt, sha256Hex16 } from './storage.js';
import { assertSendBodySize, bodyBytes, storeMailBody } from './mail-body.js';
import { forwardReceivedMail, type ForwardAttachment } from './forwarding.js';
import { enqueueMailNotifications, processNotificationJobs } from './notification-jobs.js';
import { retainExternalAttachments } from './external-attachment.js';
import { bindIdempotentSend, type IdempotencyHandle } from './idempotency.js';
import { injectAttachmentLinks, stripAttachmentLinks, type AttachmentLink } from './attachment-links.js';
export { injectAttachmentLinks } from './attachment-links.js';

export interface Sender {
  userId: number;
  role: Role;
}

interface AttachmentBase {
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
  /** 来源详情把 CID 替换成本站下载 URL；重发时据此恢复 MIME 内联引用。 */
  sourceAttachmentId?: number;
}

/** 请求自带内容的附件（base64 内联） */
export interface BytesAttachment extends AttachmentBase {
  bytes: Uint8Array;
  /** 请求里的 base64 原串：与请求体共用同一个字符串，不另占内存；组装 MIME 时直接复用，免得再编码一份 */
  base64?: string;
}

/** 引用已有 R2 对象的附件（上传草稿、转发的原附件）：附件行直接引用该对象，不复制；字节只在需要时读取 */
export interface StoredAttachment extends AttachmentBase {
  r2Key: string;
  size: number;
}

export type DecodedAttachment = BytesAttachment | StoredAttachment;

function attachmentSize(attachment: DecodedAttachment): number {
  return 'bytes' in attachment ? attachment.bytes.byteLength : attachment.size;
}

async function attachmentBytes(env: Env, attachment: DecodedAttachment): Promise<Uint8Array> {
  if ('bytes' in attachment) return attachment.bytes;
  const object = await env.r2.get(attachment.r2Key);
  if (!object) throw new Error(`附件「${attachment.filename}」内容不存在`);
  return new Uint8Array(await object.arrayBuffer());
}

/** 只给 contentId、不给 disposition 时按内联图处理 */
export function attachmentDisposition(ref: { contentId?: string; disposition?: string }): string {
  return ref.disposition ?? (ref.contentId ? 'inline' : 'attachment');
}

/** D1 写入结果不明时也只登记清理；任务执行前检查活引用，不能直接擦除可能已提交的对象。 */
async function queueObjectCleanup(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try { await createDb(env).insert(storageCleanupJobs).values(keys.map(r2Key => ({ r2Key }))).onConflictDoNothing(); }
  catch (error) { console.error('发件对象清理登记失败:', error); }
}

/** 地址写法：路由传入已解析的 MailAddress；服务内部与测试也可直接传地址字符串 */
type AddressInput = string | MailAddress;

/** sendMail 所需请求字段（base64 内联与 token 引用两种发送的共有子集） */
export interface SendMailInput {
  from: SendFrom;
  to: AddressInput[];
  cc: AddressInput[];
  bcc: AddressInput[];
  replyTo?: AddressInput[];
  /** 已由 schema 校验并规范名称的自定义头 */
  headers?: Record<string, string>;
  subject: string;
  text?: string;
  html?: string;
  replyToMessageId?: number;
  forwardAttachmentsFrom?: number;
  /** 回复/转发接口已按同一可见口径读过的来源邮件：上面两个 id 指向它时不再重复读取 */
  verifiedSource?: VerifiedSource;
}

type VerifiedSource = Pick<typeof messages.$inferSelect, 'id' | 'messageId' | 'inReplyTo' | 'references'>;

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

/** 规范化地址并按地址去重（保留第一次出现的显示名） */
function uniqueAddresses(list: AddressInput[]): MailAddress[] {
  const seen = new Map<string, MailAddress>();
  for (const item of list) {
    const value = typeof item === 'string' ? { address: item, name: '' } : item;
    const address = normalizeEmail(value.address);
    assertNoHeaderInjection(address);
    assertNoHeaderInjection(value.name);
    if (!seen.has(address)) seen.set(address, { address, name: value.name ?? '' });
  }
  return [...seen.values()];
}

/** 非结构化头可以写成 encoded-word；其余白名单头只收 ASCII，原样写出 */
const UNSTRUCTURED_HEADERS = new Set(['Comments', 'Keywords', 'Organization', 'Thread-Topic']);

/** 自定义头写进 MIME 的头行；结构化头里有无法折行的超长片段时在任何副作用之前拒绝 */
function customHeaderLines(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {}).map(([name, value]) => {
    if (name.startsWith('X-') || UNSTRUCTURED_HEADERS.has(name)) return `${name}: ${encodeUnstructuredValue(value)}`;
    if (hasUnfoldableToken(value)) {
      throw new AppError('validation_failed', `邮件头 ${name}：有超过 ${MAX_HEADER_TOKEN_BYTES} 字节且不含空白的片段，无法按邮件行长限制折行`,
        { details: { headers: [name] } });
    }
    return `${name}: ${value}`;
  });
}

/** base64 内联附件解码（供 route 层调用）；内容已由 schema 校验并去掉空白 */
export function decodeInlineAttachments(
  atts: { filename: string; contentType: string; content: string; contentId?: string; disposition?: string }[],
): BytesAttachment[] {
  return atts.map((a) => {
    let bytes: Uint8Array;
    try { bytes = base64ToBytes(a.content); }
    catch { throw new AppError('validation_failed', '附件需为合法 base64'); }
    return {
      filename: a.filename,
      mimeType: a.contentType,
      contentId: a.contentId ?? '',
      disposition: attachmentDisposition(a),
      bytes,
      base64: a.content,
    };
  });
}

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
  const cur = await bumpCounter(env, OUTBOUND_QUOTA_SCOPE, subject, window, 1, recipientCount);
  const overMails = quota.dailyOutbound > 0 && cur.count > quota.dailyOutbound;
  const overRecipients = quota.dailyRecipients > 0 && cur.units > quota.dailyRecipients;
  if (overMails || overRecipients) {
    // 拒绝的这次不该占额度，立即回退
    await bumpCounter(env, OUTBOUND_QUOTA_SCOPE, subject, window, -1, -recipientCount);
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
  await bumpCounter(env, OUTBOUND_QUOTA_SCOPE, String(sender.userId), dayWindow(), -1, -recipientCount);
}

const FORBIDDEN_SENDER: AppErrorHints = {
  fix: '先调 GET /v1/identities（网页会话用 /api/identities），从 canSend=true 的地址里选一个作为 from；共享给你的邮箱只能读，不能发信',
  docs: '/references/errors.md#forbidden-sender',
};

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
      throw new AppError('forbidden', '无权使用该发件地址', FORBIDDEN_SENDER);
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
    // 托管域名所有者可用本域任意前缀：未认领的地址先认领给他（成员与共享不适用），与归属查询同一次往返
    const [, owner] = await env.db.batch([
      env.db.prepare(HOSTED_SEND_CLAIM_SQL).bind(address, domain, sender.userId),
      env.db.prepare('SELECT user_id FROM mailboxes WHERE address = ?').bind(address),
    ]);
    const ownerId = (owner?.results?.[0] as { user_id: number } | undefined)?.user_id;
    if (Number(ownerId) !== sender.userId) throw new AppError('forbidden', '只能使用自己认领的地址发件', FORBIDDEN_SENDER);
  }
  const displayName = (req.from.displayName || req.from.localPart!).trim();
  assertNoHeaderInjection(displayName);
  return { address, domain, displayName };
}

/**
 * 转发时把原邮件的附件带入本次发送：校验可见性（同详情）后直接引用原对象，不复制也不读内容，
 * 只用 HEAD 确认对象还在；来源或附件不可用为 source_unavailable
 */
async function loadForwardedAttachments(
  env: Env,
  db: Db,
  sender: Sender,
  sourceMessageId: number,
  alreadyCount: number,
  alreadyBytes: number,
  verified?: VerifiedSource,
): Promise<StoredAttachment[]> {
  if (verified?.id !== sourceMessageId) await loadSourceMessage(env, sender, sourceMessageId, '转发的原邮件不存在或不可见');
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
  const heads = await Promise.all(rows.map((row) => env.r2.head(row.r2Key)));
  const missing = rows.find((_, index) => !heads[index]);
  if (missing) throw new AppError('source_unavailable', `附件「${missing.filename}」已丢失，无法完整转发`);
  // 保留原始 contentId/disposition：此前硬编码成 ''/attachment，转发一封带内嵌图片的
  // 富文本邮件时，HTML 里的 <img src="cid:xxx"> 在 MIME 里再也找不到对应 part，
  // 收件端图片全裂、还平白多出一堆附件
  return rows.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    contentId: a.contentId,
    disposition: a.disposition,
    sourceAttachmentId: a.id,
    r2Key: a.r2Key,
    size: a.size,
  }));
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
  const uploadedKeys: string[] = [];
  try {
    // 引用已有对象的附件行直接指向原 key；只有请求自带的字节才写成新对象
    const rows = await Promise.all(atts.map(async (att, seq) => ({
      messageId,
      r2Key: 'r2Key' in att ? att.r2Key : attachmentKey(messageId, seq, await sha256Hex16(att.bytes), getExt(att.filename)),
      filename: att.filename,
      mimeType: att.mimeType,
      size: attachmentSize(att),
      contentId: att.contentId,
      disposition: att.disposition,
    })));
    // 先为全部对象登记发送中的独立引用。发件记录被 purge/release 删除时，清理仍须等待投递结束。
    await db.insert(deliveryObjectLeases).values([...new Set(rows.map(row => row.r2Key))].map(r2Key => ({
      r2Key, token: leaseToken, expiresAt: new Date(Date.now() + 3600_000),
    })));
    for (let index = 0; index < rows.length; index++) {
      const att = atts[index]!;
      if (!('bytes' in att)) continue;
      await env.r2.put(rows[index]!.r2Key, att.bytes, { httpMetadata: { contentType: att.mimeType } });
      uploadedKeys.push(rows[index]!.r2Key);
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

interface OutboundMimeInput {
  from: ResolvedFrom;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  /** 线程头与自定义头（已编码的完整头行） */
  headerLines: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

/**
 * 准备外发 MIME 原文的组装器。头里写完整 To/Cc，不写 Bcc；同一封邮件的外部收件人共用同一份原文，
 * 只有 To 为空（仅抄送/密送）时 To 头随信封收件人变化，按收件人各自组装。正文与附件的 base64 只编码一次，
 * 逐收件人组装时不缓存原文，内存随并发路数而不是收件人数增长。
 */
async function prepareOutboundMime(
  env: Env,
  input: OutboundMimeInput,
  atts: DecodedAttachment[],
): Promise<(target: string) => string> {
  // 动态 import：mimetext 在 vitest workerd 里静态加载会崩，且集成测试不发外部邮件
  const { createMimeMessage } = await import('mimetext/browser');
  // base64 编码正文：见 encodeBodyBase64 的说明（7bit 原样输出会撞 998 字节行限）
  const textData = input.text ? encodeBodyBase64(input.text) : '';
  const htmlData = input.html ? encodeBodyBase64(input.html) : '';
  const parts: { filename: string; contentType: string; data: string; contentId: string; inline: boolean }[] = [];
  for (const a of atts) {
    // 折行成 76 字符/行：不折行时整个附件是一整行，超 SMTP 998 字节行限会被下游 MTA 拒收。
    // filename/mimeType 走清洗：mimetext 是裸拼进头的，值里的引号/CRLF 会改写 part 头结构
    const base64 = 'bytes' in a && a.base64 ? a.base64 : bytesToBase64(await attachmentBytes(env, a));
    parts.push({
      filename: sanitizeFilename(a.filename),
      contentType: sanitizeMimeType(a.mimeType),
      data: foldBase64(base64),
      // Content-ID 来自请求校验或入站解析；只放行可见 ASCII，避免改写 part 头
      contentId: /^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(a.contentId) ? a.contentId : '',
      inline: a.disposition === 'inline',
    });
  }
  const build = (to: MailAddress[]): string => {
    const msg = createMimeMessage();
    msg.setSender({ name: input.from.displayName, addr: input.from.address });
    msg.setSubject(input.subject);
    msg.setHeader('Message-ID', input.messageId);
    if (textData) msg.addMessage({ contentType: 'text/plain', charset: 'UTF-8', encoding: 'base64', data: textData });
    if (htmlData) msg.addMessage({ contentType: 'text/html', charset: 'UTF-8', encoding: 'base64', data: htmlData });
    for (const part of parts) {
      // 内联图片要带 Content-ID + inline（mimetext 据此生成 multipart/related），否则正文里的
      // <img src="cid:xxx"> 全裂、还会多出一堆莫名其妙的附件
      msg.addAttachment({
        filename: part.filename,
        contentType: part.contentType,
        data: part.data,
        ...(part.inline && part.contentId ? { inline: true } : {}),
        ...(part.contentId ? { headers: { 'Content-ID': `<${part.contentId}>` } } : {}),
      });
    }
    // 地址头自己组装（mimetext 的显示名写法见 formatMailbox）；Reply-To 的 setter 也只接受单个地址
    const lines = [
      formatAddressHeader('To', to),
      ...(input.cc.length ? [formatAddressHeader('Cc', input.cc)] : []),
      ...(input.replyTo.length ? [formatAddressHeader('Reply-To', input.replyTo)] : []),
      ...input.headerLines,
    ];
    return foldMimeHeaders(`${lines.join('\r\n')}\r\n${msg.asRaw()}`);
  };
  let shared: string | undefined;
  return (target) => (input.to.length ? (shared ??= build(input.to)) : build([{ address: target, name: '' }]));
}

/** Cloudflare 原生发信（send_email binding），逐收件人投递同一份原文；并发投递前只 import 一次 */
async function cloudflareSender(env: Env, fromAddress: string): Promise<(toAddr: string, raw: string) => Promise<void>> {
  // 动态 import：`cloudflare:email` 在 vitest workerd 里静态加载会崩
  const { EmailMessage } = await import('cloudflare:email');
  return async (toAddr, raw) => { await env.email.send(new EmailMessage(fromAddress, toAddr, raw)); };
}

/** 有界并发：最多 limit 个任务同时进行 */
async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  }));
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
    verificationLink: row.verificationLink,
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

/** 校验并构造回复线程头（回复的原邮件须对发件人可见，同详情口径，不存在与不可见同为 source_unavailable） */
async function resolveReply(
  env: Env,
  sender: Sender,
  replyToMessageId: number | undefined,
  verified?: VerifiedSource,
): Promise<{ reply: ReplyContext | null; inReplyTo: string | null; references: string }> {
  if (!replyToMessageId) return { reply: null, inReplyTo: null, references: '' };
  const orig = verified?.id === replyToMessageId
    ? verified : await loadSourceMessage(env, sender, replyToMessageId, '回复的原邮件不存在或不可见');
  if (!orig.messageId) return { reply: null, inReplyTo: null, references: '' };
  const references = [...new Set([orig.references, orig.inReplyTo, orig.messageId]
    .filter(Boolean).flatMap(value => value!.match(/<[^<>\s]+>/g) ?? []))].join(' ');
  assertNoHeaderInjection(orig.messageId);
  return { reply: { inReplyTo: orig.messageId, references }, inReplyTo: orig.messageId, references };
}

/**
 * 决定外发邮件的实际负载：正文+附件 base64 ≤ 4MiB 时直发附件；超限则附件转下载链接
 * 注入正文、MIME 不带附件（绕过 send_email 5MiB 硬限）。只按大小判断，不读附件内容。
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
    atts.reduce((sum, a) => sum + Math.ceil(attachmentSize(a) * 1.38), 0);
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

/** 全部收件人都尝试过且都被明确拒收：422，details 带发件行与逐收件人结果（同 Key 重放返回同样的错误） */
export function deliveryFailedError(messageId: number, outcomes: RecipientOutcome[], message: string): AppError {
  return new AppError('delivery_failed', message, { details: { messageId, recipientOutcomes: outcomes } });
}

/**
 * 逐收件人结果的增量回填：写入串行，排队期间到达的结果合并进下一次写入；只改仍是 pending 的行，
 * 不会覆盖最终结果。失败只记日志，不影响投递。
 */
function outcomeWriter(db: Db, messageId: number, snapshot: () => RecipientOutcome[]) {
  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  return {
    write(): void {
      if (queued) return;
      queued = true;
      chain = chain.then(async () => {
        queued = false;
        try {
          await db.update(messages).set({ recipientOutcomes: snapshot() })
            .where(and(eq(messages.id, messageId), eq(messages.status, 'pending')));
        } catch (error) { console.error('逐收件人结果增量回填失败:', error); }
      });
    },
    settled: () => chain,
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  let text = req.text ?? '';
  let html = req.html ?? '';
  assertSendBodySize(text, html);
  const to = uniqueAddresses(req.to);
  const cc = uniqueAddresses(req.cc);
  const bcc = uniqueAddresses(req.bcc);
  const replyTo = uniqueAddresses(req.replyTo ?? []);
  const customHeaders = customHeaderLines(req.headers);
  const settings = await getSettings(env);
  const db = createDb(env);
  // 只需判断发件域与各收件人域是否可站内路由，按需查询这些域而不是读出全部认领域名
  const candidateDomains = [
    ...(req.from.domain ? [req.from.domain] : []),
    ...[...to, ...cc, ...bcc].map(item => getEmailDomain(item.address)),
  ];
  const domains = await getRoutableDomains(env, settings, candidateDomains);
  const from = await resolveFrom(env, sender, req, domains);
  await assertHostedSendable(env, settings, from.domain);
  if (req.forwardAttachmentsFrom) {
    const forwarded = await loadForwardedAttachments(env, db, sender, req.forwardAttachmentsFrom,
      attachments.length, attachments.reduce((sum, att) => sum + attachmentSize(att), 0), req.verifiedSource);
    attachments = [...attachments, ...forwarded];
    const siteOrigin = env.site_origin ?? origin;
    // 补发/重发沿用的正文里有上次注入的下载区块：这些附件会重新带上，先去掉旧区块再判断是否重新注入，
    // 否则正文会出现两段「附件下载」。必须在下面把下载 URL 改回 cid: 之前做，否则旧区块里的链接先被改坏
    ({ text, html } = stripAttachmentLinks(text, html, new URL(siteOrigin).origin,
      new Set(forwarded.map(attachment => attachment.sourceAttachmentId!))));
    const sourceCids = new Map(forwarded.filter(attachment => attachment.disposition === 'inline' && attachment.contentId)
      .map(attachment => [attachment.sourceAttachmentId!, attachment.contentId]));
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
  const totalAttachmentBytes = attachments.reduce((sum, att) => sum + attachmentSize(att), 0);
  if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError('payload_too_large', '附件合计超过大小上限');
  }
  const recipients = {
    to: to.map(item => item.address),
    cc: cc.map(item => item.address),
    bcc: bcc.map(item => item.address),
  };
  const replyToAddresses = replyTo.map(item => item.address);
  const uniqueTargets = [...new Set([...recipients.to, ...recipients.cc, ...recipients.bcc])];
  const externalTargets = uniqueTargets.filter(address => !domains.includes(getEmailDomain(address)));
  const internalTargets = uniqueTargets.filter(address => domains.includes(getEmailDomain(address)));
  const resolved = await resolveReply(env, sender, req.replyToMessageId, req.verifiedSource);
  // 回复站内邮件由 replyToMessageId 生成线程头；只知道站外 Message-ID 时由 headers 自带（两者互斥由 schema 保证），
  // 同样写进发件行与站内副本，线程才能连上
  const thread = resolved.reply
    ? { inReplyTo: resolved.inReplyTo, references: resolved.references }
    : { inReplyTo: req.headers?.['In-Reply-To'] ?? null, references: req.headers?.References ?? '' };
  const headerLines = [
    ...(resolved.reply ? [`In-Reply-To: ${resolved.reply.inReplyTo}`, `References: ${resolved.reply.references}`] : []),
    ...customHeaders,
  ];
  const outgoingMessageId = `<${crypto.randomUUID()}@${from.domain}>`;
  const preview = makePreview(text, html);
  const size = bodyBytes(text, html) + totalAttachmentBytes;
  const code = settings.code_extract.enabled ? extractCodeByRegex(req.subject, text) : '';
  // 只写站内收件副本；发件记录本身不是「收到的验证邮件」
  const verificationLink = settings.code_extract.enabled && internalTargets.length
    ? extractVerificationLink({ subject: req.subject, text, html, fromAddress: from.address }) : '';
  await assertOutboundQuota(env, settings.quota, sender, uniqueTargets.length);

  let outbound: typeof messages.$inferSelect | undefined;
  let storedBody: Awaited<ReturnType<typeof storeMailBody>> | undefined;
  try {
    storedBody = await storeMailBody(env, text, html);
    outbound = await db.insert(messages).values({
      direction: 'outbound', address: from.address, domain: from.domain,
      fromAddress: from.address, fromName: from.displayName, recipients,
      replyTo: replyToAddresses, subject: req.subject, preview, ...storedBody,
      verificationCode: code, messageId: outgoingMessageId, ...thread,
      status: 'pending', sendChannel: externalTargets.length ? 'cloudflare' : 'internal',
      errorDetail: '', isRead: true, size, createdAt: new Date(),
    }).returning().get();
    if (!outbound) throw new AppError('internal', '发送记录创建失败');
    // 绑定失败（幂等状态已变化）时同批把发件行标 failed，不留永久 pending
    await bindIdempotentSend(env, handle, outbound.id);
  } catch (error) {
    // 发件行已插入但尚未外发（如绑定幂等键的 batch 抛 D1 异常）：标为 failed，不留永久 pending。
    // 尽力而为，失败只记日志，不覆盖原始错误
    if (outbound) {
      try {
        await db.update(messages)
          .set({ status: 'failed', errorDetail: errorText(error).slice(0, 2000) })
          .where(and(eq(messages.id, outbound.id), eq(messages.status, 'pending')));
      } catch (markError) { console.error('未外发的发件行标记失败延迟:', markError); }
    }
    await releaseOutboundQuota(env, settings.quota, sender, uniqueTargets.length);
    if (!outbound && storedBody?.bodyR2Key) await queueObjectCleanup(env, [storedBody.bodyR2Key]);
    throw error;
  }
  const sent = outbound;

  // 外部与站内目标的投递顺序即结果顺序
  const targets = [...externalTargets, ...internalTargets];
  const results = new Map<string, RecipientOutcome>();
  const ordered = () => targets.flatMap(target => results.get(target) ?? []);
  const writer = outcomeWriter(db, sent.id, ordered);
  const record = (outcome: RecipientOutcome) => {
    results.set(outcome.address, outcome);
    // 最后一个结果随最终状态一起写，不多一次往返
    if (results.size < targets.length) writer.write();
  };
  const internalDeliveries: { target: string; messageId: number; ownerIds: number[] }[] = [];

  /**
   * 投递阶段交给 waitUntil 托住：客户端断开或请求被取消时仍会投递完并回填结果；请求里照常等待最终结果。
   * 中途出现服务端故障（附件持久化等）时，没尝试的目标记为失败并带上原因。
   */
  const deliver = async () => {
    let processingError = '';
    let outboundAtts: Awaited<ReturnType<typeof persistAttachments>> = [];
    const objectLeaseToken = crypto.randomUUID();

    const deliverExternal = async () => {
      if (!externalTargets.length) return;
      try {
        const payload = await buildExternalPayload(env, origin, text, html, attachments, outboundAtts);
        // 展示正文必须在首次外发前保存，发送成功后不再依赖正文持久化。
        if (payload.text !== text || payload.html !== html) {
          const originalKey = storedBody!.bodyR2Key;
          const actualBody = await storeMailBody(env, payload.text, payload.html);
          const updateBody = db.update(messages).set(actualBody).where(eq(messages.id, sent.id));
          if (originalKey) await db.batch([
            db.insert(storageCleanupJobs).values({ r2Key: originalKey }).onConflictDoNothing(), updateBody,
          ]);
          else await updateBody;
          storedBody = actualBody;
        }
        const rawFor = await prepareOutboundMime(env, {
          from, to, cc, replyTo, headerLines, subject: req.subject, text: payload.text, html: payload.html,
          messageId: outgoingMessageId,
        }, payload.atts);
        const send = await cloudflareSender(env, from.address);
        await runPool(externalTargets, OUTBOUND_DELIVERY_CONCURRENCY, async (target) => {
          try {
            await send(target, rawFor(target));
            record({ address: target, status: 'sent' });
          } catch (error) {
            record({ address: target, status: 'failed', error: errorText(error) });
          }
        });
      } catch (error) {
        processingError ||= errorText(error);
      }
    };

    const deliverInternal = async () => {
      for (const target of internalTargets) {
        let body: Awaited<ReturnType<typeof storeMailBody>> | undefined;
        let incoming: { id: number } | undefined;
        let ownerIds: number[] = [];
        try {
          // 每封站内副本独立持有正文对象，删除一封副本不会擦除其他收件人的正文。
          // 托管域名停用时拒收；未认领地址先归域名所有者，再落库
          const recipient = await resolveDeliveryOwners(env, target);
          if (recipient.rejected) throw new Error(recipient.rejected);
          ownerIds = recipient.ownerIds;
          body = await storeMailBody(env, text, html);
          const insertMessage = db.insert(messages).values({
            direction: 'inbound', address: target, domain: getEmailDomain(target),
            fromAddress: from.address, fromName: from.displayName,
            recipients: { to: recipients.to, cc: recipients.cc, bcc: [] }, replyTo: replyToAddresses,
            notifyOwnerIds: ownerIds,
            subject: req.subject, preview, ...body, verificationCode: code, verificationLink,
            messageId: outgoingMessageId, ...thread, status: 'received',
            sendChannel: 'internal', isRead: false, size, createdAt: new Date(),
          }).returning({ id: messages.id });
          if (outboundAtts.length) {
            // D1 batch 是事务：附件引用失败时收件副本也回滚，不能把缺附件的邮件报成已送达。
            // 附件行引用同一批对象（不复制、不读内容），内联图的 content_id/disposition 一并保留
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
          record({ address: target, status: 'failed', error: errorText(error) });
          continue;
        }
        // 正文与全部附件引用已原子落库，后续状态回填失败不改变已投递的事实。
        record({ address: target, status: 'delivered' });
        internalDeliveries.push({ target, messageId: incoming.id, ownerIds });
      }
    };

    // 引用的已有对象（草稿、转发的原附件）由原持有方管理回收：草稿行不算清理引用，投递后在这里登记会在草稿还能重发时删掉对象
    const borrowedKeys = [...new Set(attachments.flatMap(att => ('r2Key' in att ? [att.r2Key] : [])))];
    try {
      outboundAtts = await persistAttachments(env, db, sent.id, attachments, objectLeaseToken);
      await Promise.all([deliverExternal(), deliverInternal()]);
    } catch (error) {
      processingError = errorText(error);
    } finally {
      if (attachments.length) {
        try {
          // purge 可在附件元数据插入前删除发件记录；清除这种晚插入的孤儿行，避免永久阻塞对象回收。
          await db.batch([
            db.insert(storageCleanupJobs).select(db.select({ r2Key: deliveryObjectLeases.r2Key,
              createdAt: sql<Date>`${Date.now()}`.as('created_at'), lastError: sql<string>`''`.as('last_error') })
              .from(deliveryObjectLeases).where(and(eq(deliveryObjectLeases.token, objectLeaseToken),
                borrowedKeys.length ? notInArray(deliveryObjectLeases.r2Key, borrowedKeys) : undefined))).onConflictDoNothing(),
            db.delete(attachmentsTable).where(and(eq(attachmentsTable.messageId, sent.id),
              sql`not exists (select 1 from messages where id = ${sent.id})`)),
            db.delete(deliveryObjectLeases).where(eq(deliveryObjectLeases.token, objectLeaseToken)),
          ]);
        } catch (error) {
          // 暂时保持引用，cron 在租约到期后恢复回收；投递已完成的邮件不能因此改报失败。
          console.error('发送中附件引用释放延迟:', error);
        }
      }
    }
    const untried = targets.filter(target => !results.has(target));
    for (const target of untried) {
      results.set(target, { address: target, status: 'failed', error: processingError || '投递未执行' });
    }
    const outcomes = ordered();
    const delivered = outcomes.filter(outcome => outcome.status !== 'failed');
    const status = delivered.length ? (delivered.some(outcome => outcome.status === 'sent') ? 'sent' : 'delivered') : 'failed';
    const errors = outcomes.filter(outcome => outcome.error).map(outcome => `${outcome.address}: ${outcome.error}`);
    const errorDetail = !errors.length ? '' : delivered.length
      ? `部分收件人失败: ${errors.join('; ')}` : `全部收件人投递失败: ${errors.join('; ')}`;
    // 增量写入排空后再写最终结果；至少重试一次，两次皆失败时保留 pending 幂等占位，禁止再次外发（cron 稍后标 unknown）。
    await writer.settled();
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        await db.update(messages).set({ status, errorDetail, recipientOutcomes: outcomes })
          .where(eq(messages.id, sent.id));
        saved = true;
      } catch (error) { console.error('投递结果回填失败:', error); }
    }
    if (!delivered.length) {
      try { await releaseOutboundQuota(env, settings.quota, sender, uniqueTargets.length); }
      catch (error) { console.error('外发配额退还失败:', error); }
    } else if (internalDeliveries.length) {
      ctx.waitUntil(notifyInternalDeliveries());
    }
    return { outcomes, status, errorDetail, allAttempted: untried.length === 0, delivered: delivered.length > 0 };
  };

  // 站内收件与 SMTP 收件统一转发及通知；每次发送只启动一组有界通知处理器。
  const notifyInternalDeliveries = async () => {
    // 附件字节只在有归属人开启邮箱转发时读取，同一封信的多份副本共用一次读取
    let forwardAttachments: Promise<ForwardAttachment[]> | undefined;
    const loadForwardAttachments = () => (forwardAttachments ??= Promise.all(attachments.map(async att => ({
      filename: att.filename, mimeType: att.mimeType, contentId: att.contentId, disposition: att.disposition,
      content: await attachmentBytes(env, att),
    }))));
    const forwarding: Promise<void>[] = [];
    for (const delivery of internalDeliveries) {
      try {
        const ownerIds = delivery.ownerIds;
        forwarding.push(Promise.all(ownerIds.map(id => getUserNotifyPrefs(env, id))).then(async (prefs) => {
          if (!prefs.some(pref => pref.forward.enabled && pref.forward.addresses.length)) return;
          await forwardReceivedMail(env, {
            messageId: delivery.messageId, ownerIds,
            fromAddress: from.address, fromName: from.displayName, toAddress: delivery.target,
            domain: getEmailDomain(delivery.target), subject: req.subject, text, html, replyTo: replyToAddresses,
            attachments: await loadForwardAttachments(),
          }, prefs);
        }).catch(error => console.error('站内转发失败:', error)));
        await enqueueMailNotifications(env, null, {
          ownerIds, message: { id: delivery.messageId, address: delivery.target,
            fromAddress: from.address, fromName: from.displayName, subject: req.subject,
            verificationCode: code, verificationLink, preview, createdAt: new Date().toISOString() }, text, html,
        });
      } catch (error) { console.error('站内转发/通知入队失败:', error); }
    }
    await Promise.all([processNotificationJobs(env, { limit: 8, concurrency: 4 }), ...forwarding]);
  };

  const delivery = deliver();
  ctx.waitUntil(delivery.then(() => undefined, (error: unknown) => console.error('投递任务异常结束:', error)));
  const result = await delivery;
  if (!result.delivered) {
    // 每个目标都尝试过才是确定的拒收；处理中途的服务端故障（有目标没尝试）仍是 500
    if (result.allAttempted) throw deliveryFailedError(sent.id, result.outcomes, result.errorDetail);
    throw new AppError('internal', result.errorDetail || '发送失败');
  }
  // 与列表口径一致：正文内联图不算「有附件」
  const hasAttachments = attachments.some(att => !(att.disposition === 'inline' && att.contentId));
  return summarize({ ...sent, ...storedBody!, status: result.status, errorDetail: result.errorDetail,
    recipientOutcomes: result.outcomes }, hasAttachments, false);
}
