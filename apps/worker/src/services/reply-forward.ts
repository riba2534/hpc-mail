import {
  MAX_BODY_BYTES,
  MAX_RECIPIENTS,
  domainSchema,
  formatMailAddress,
  localPartSchema,
  type ForwardMessageRequest,
  type MailAddress,
  type ReplyMessageRequest,
  type Role,
  type SendFrom,
} from '@hpc-mail/shared';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import { escapeHtml, htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';
import { bodyBytes, readMailBody } from './mail-body.js';
import { loadSourceContent, type SourceViewer } from './message.js';
import type { SendMailInput } from './outbound.js';

type Source = Awaited<ReturnType<typeof loadSourceContent>>;
type MailBody = Awaited<ReturnType<typeof readMailBody>>;

/** 回复/转发准备好的发信请求；fromIsDefault 时发件身份无权使用要改报 from_required */
export interface ComposedSend {
  req: SendMailInput;
  fromIsDefault: boolean;
  /** 来源邮件的收件地址（发件身份缺省时用它） */
  sourceAddress: string;
}

const FROM_REQUIRED_FIX = '先调 GET /v1/identities，从 canSend=true 的地址里选一个填进 from（写法同 POST /v1/messages）';

export function fromRequiredError(address: string): AppError {
  return new AppError('from_required', `原信的收件地址 ${address} 不是你可用的发件身份（例如共享给你的邮箱），请在 from 指定自己的地址`, {
    fix: FROM_REQUIRED_FIX,
    docs: '/references/errors.md#from_required',
  });
}

/** 主题上限：与发信 schema 的 998 一致，按 UTF-8 字节计，同时满足字符数上限与邮件头的单行字节限制 */
const MAX_SUBJECT_BYTES = 998;

/** 按 UTF-8 字节截断，只在完整字符（码点）之间切，不留半个代理对 */
function clipUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return value.slice(0, end);
}

/** 主题前缀：已带同类前缀不重复加；加上前缀后超出主题上限时截断（原信主题最长可到 2048 字符） */
function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const trimmed = subject.trim() || '(无主题)';
  const pattern = prefix === 'Re' ? /^re:/i : /^(fwd?|转发):/i;
  return clipUtf8(pattern.test(trimmed) ? trimmed : `${prefix}: ${trimmed}`, MAX_SUBJECT_BYTES).trimEnd();
}

function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const formatSender = (source: Source) => formatMailAddress({ address: source.fromAddress, name: source.fromName });

/** 原 HTML 只取 body 内部，去掉脚本；没有 body 时整段使用 */
function htmlInner(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return (body ? body[1]! : html).replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
}

const textToHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

interface QuoteSource {
  /** 引用头部各行（发件人、时间、主题等） */
  header: string[];
  /** 原文纯文本（原信只有 HTML 时由 HTML 转出） */
  text: string;
  /** 原文 HTML（原信没有 HTML 时为空） */
  html: string;
}

function quoteSource(body: MailBody, header: string[]): QuoteSource {
  return { header, text: body.bodyText.trim() ? body.bodyText : htmlToText(body.bodyHtml), html: body.bodyHtml };
}

const TRUNCATED = '（原文过长，已截断）';
/** 头部、分隔与截断说明的余量 */
const BODY_MARGIN = 4096;

/**
 * 把原文附在用户正文之后。withHtml 决定是否产出 HTML 部分；正文合计超过上限时先把 HTML 引用换成转义后的纯文本，
 * 仍超就截断引用的原文并注明，不报错。
 */
function attachQuote(
  user: { text: string; html: string },
  quote: QuoteSource,
  withHtml: boolean,
  style: 'reply' | 'forward',
): { text: string; html: string } {
  const separator = style === 'reply' ? '----- 原始邮件 -----' : '---------- 转发的邮件 ----------';
  const textHeader = [separator, ...quote.header].join('\n');
  const build = (original: string, originalHtml: string | null, note = '') => {
    const quotedText = style === 'reply'
      ? original.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
      : original;
    const text = [user.text, user.text ? '' : null, textHeader, '', quotedText + note].filter((part) => part !== null).join('\n');
    if (!withHtml) return { text, html: '' };
    const headerHtml = `<div>${[separator, ...quote.header].map(escapeHtml).join('<br>')}</div>`;
    const bodyHtml = originalHtml ?? textToHtml(original + note);
    const quoted = style === 'reply'
      ? `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${bodyHtml}</blockquote>`
      : `<div>${bodyHtml}</div>`;
    return { text, html: `${user.html}${user.html ? '<br><br>' : ''}${headerHtml}<br>${quoted}` };
  };
  const fits = (body: { text: string; html: string }) => bodyBytes(body.text, body.html) <= MAX_BODY_BYTES;
  const full = build(quote.text, quote.html ? htmlInner(quote.html) : null);
  if (fits(full)) return full;
  const plain = build(quote.text, null);
  if (fits(plain)) return plain;
  // UTF-8 最多 4 字节/字符，「> 」前缀每行再加 2 字节：按保守比例截断原文，再核对一次
  const budget = MAX_BODY_BYTES - bodyBytes(user.text, user.html) - BODY_MARGIN;
  const share = withHtml ? 3 : 1;
  const truncated = build(quote.text.slice(0, Math.max(0, Math.floor(budget / share / 6))), null, `\n${TRUNCATED}`);
  if (fits(truncated)) return truncated;
  throw new AppError('payload_too_large', '正文与引用合计超过大小上限', { fix: '缩短正文，或设 quote:false / includeOriginal:false' });
}

/** 地址拆成 from 的 localPart+domain 写法；前缀不合本站规则时返回 null */
function addressAsFrom(address: string): SendFrom | null {
  const at = address.lastIndexOf('@');
  const localPart = localPartSchema.safeParse(address.slice(0, at));
  const domain = domainSchema.safeParse(address.slice(at + 1));
  return localPart.success && domain.success ? { localPart: localPart.data, domain: domain.data } : null;
}

interface CandidateOwner { id: number; address: string; userId: number }

/** 候选地址在本站的认领情况（一次读取，按 D1 绑定参数上限分批） */
async function ownersOf(env: Env, addresses: string[], mailboxId: number | undefined): Promise<CandidateOwner[]> {
  const unique = [...new Set(addresses.map((address) => address.toLowerCase()))];
  const statements = chunk(unique, 90).map((batch) => env.db.prepare(
    `SELECT id, address, user_id AS userId FROM mailboxes WHERE address IN (${batch.map(() => '?').join(', ')})`,
  ).bind(...batch));
  if (mailboxId !== undefined) statements.push(env.db.prepare('SELECT id, address, user_id AS userId FROM mailboxes WHERE id = ?').bind(mailboxId));
  if (!statements.length) return [];
  const results = await env.db.batch<CandidateOwner>(statements);
  return results.flatMap((result) => result.results ?? []).map((row) => ({ ...row, id: Number(row.id), userId: Number(row.userId) }));
}

/**
 * 发件身份：显式 from 原样交给发信鉴权；缺省用原信的收件地址——自己认领的用 mailboxId（带邮箱显示名），
 * 别人认领的（共享来的）直接要求显式 from，未认领的交给发信鉴权（管理员系统域名、托管所有者任意前缀）。
 */
function chooseFrom(
  sender: { userId: number; role: Role },
  source: Source,
  explicit: SendFrom | undefined,
  owners: CandidateOwner[],
): { from: SendFrom; fromAddress: string | null; isDefault: boolean } {
  if (explicit) {
    const address = explicit.mailboxId !== undefined
      ? owners.find((row) => row.id === explicit.mailboxId)?.address ?? null
      : `${explicit.localPart}@${explicit.domain}`;
    return { from: explicit, fromAddress: address, isDefault: false };
  }
  const address = source.address.toLowerCase();
  const holder = owners.find((row) => row.address === address);
  if (holder?.userId === sender.userId) return { from: { mailboxId: holder.id }, fromAddress: address, isDefault: true };
  // 别人认领的地址（共享来的邮件）即使管理员能用 localPart+domain 冒用，也不作为缺省发件人
  const parsed = holder ? null : addressAsFrom(address);
  if (!parsed) throw fromRequiredError(source.address);
  return { from: parsed, fromAddress: address, isDefault: true };
}

const lower = (address: string) => address.toLowerCase();

/**
 * 回复：inbound 回给原信 Reply-To（没有时回发件人），outbound（回复自己发出的信）回给原收件人；
 * replyAll 另抄送原信的其他收件人，去掉自己（本次发件地址、原收件地址与自己认领的地址），从不带原 Bcc。
 */
export async function composeReply(
  env: Env,
  sender: SourceViewer,
  sourceId: number,
  req: ReplyMessageRequest,
): Promise<ComposedSend> {
  const source = await loadSourceContent(env, sender, sourceId, '回复的原邮件不存在或不可见', 'reply');
  const recipients = source.recipients ?? { to: [], cc: [], bcc: [] };
  const inbound = source.direction === 'inbound';
  const primary: MailAddress[] = inbound
    ? (source.replyTo.length ? source.replyTo.map((address) => ({ address, name: '' })) : [{ address: source.fromAddress, name: source.fromName }])
    : recipients.to.map((address) => ({ address, name: '' }));
  const others = req.replyAll ? (inbound ? [...recipients.to, ...recipients.cc] : recipients.cc) : [];
  // 认领情况与完整正文（只在引用原文时读 R2）同时取
  const [owners, body] = await Promise.all([
    ownersOf(env, [source.address, ...others], req.from?.mailboxId),
    req.quote ? readMailBody(env, source) : undefined,
  ]);
  const chosen = chooseFrom(sender, source, req.from, owners);
  const self = new Set([lower(source.address), ...(chosen.fromAddress ? [lower(chosen.fromAddress)] : []),
    ...owners.filter((row) => row.userId === sender.userId).map((row) => row.address)]);
  let to = primary.filter((item, index) => item.address && primary.findIndex((other) => lower(other.address) === lower(item.address)) === index);
  const taken = new Set(to.map((item) => lower(item.address)));
  let cc = [...new Set(others.map(lower))].filter((address) => !self.has(address) && !taken.has(address)).map((address) => ({ address, name: '' }));
  if (!to.length) [to, cc] = [cc, []];
  if (!to.length) throw new AppError('validation_failed', '原邮件没有可回复的收件人', { fix: '改用 POST /v1/messages 自己填写收件人，并带 replyToMessageId 保持线程' });
  // 原信的 Reply-To/To/Cc 由发件方决定（入站每类最多存 200 个），回复不能借此突破单封收件人上限
  if (to.length + cc.length > MAX_RECIPIENTS) {
    throw new AppError('validation_failed', `收件人合计不能超过 ${MAX_RECIPIENTS} 个`, {
      fix: `原信的收件人超过单封上限：改用 POST /v1/messages 自己选不超过 ${MAX_RECIPIENTS} 个收件人，并带 replyToMessageId 保持线程`,
    });
  }

  let text = req.text ?? '';
  let html = req.html ?? '';
  if (body) {
    const quote = quoteSource(body, [`发件人：${formatSender(source)}`, `时间：${formatTime(source.createdAt)}`, `主题：${source.subject}`]);
    ({ text, html } = attachQuote({ text, html }, quote, Boolean(html), 'reply'));
    // 只给了 html 时不生成只有引用、没有回复内容的纯文本部分
    if (!req.text) text = '';
  }
  return {
    req: {
      from: chosen.from, to, cc, bcc: [], subject: prefixed(source.subject, 'Re'),
      ...(text ? { text } : {}), ...(html ? { html } : {}),
      ...(req.headers ? { headers: req.headers } : {}),
      replyToMessageId: source.id, verifiedSource: source,
    },
    fromIsDefault: chosen.isDefault,
    sourceAddress: source.address,
  };
}

/** 转发：note 在前，includeOriginal 时附原文；原邮件附件始终带上（沿用 forwardAttachmentsFrom 的规则） */
export async function composeForward(
  env: Env,
  sender: SourceViewer,
  sourceId: number,
  req: ForwardMessageRequest,
): Promise<ComposedSend> {
  const source = await loadSourceContent(env, sender, sourceId, '转发的原邮件不存在或不可见', 'forward');
  const [owners, body] = await Promise.all([
    ownersOf(env, [source.address], req.from?.mailboxId),
    req.includeOriginal ? readMailBody(env, source) : undefined,
  ]);
  const chosen = chooseFrom(sender, source, req.from, owners);
  const note = req.note ?? '';
  let text = note;
  let html = '';
  if (body) {
    const recipients = source.recipients ?? { to: [], cc: [], bcc: [] };
    const header = [
      `发件人：${formatSender(source)}`,
      `时间：${formatTime(source.createdAt)}`,
      `主题：${source.subject}`,
      `收件人：${recipients.to.join(', ')}`,
      ...(recipients.cc.length ? [`抄送：${recipients.cc.join(', ')}`] : []),
    ];
    ({ text, html } = attachQuote({ text: note, html: note ? textToHtml(note) : '' }, quoteSource(body, header),
      Boolean(body.bodyHtml), 'forward'));
  }
  return {
    req: {
      from: chosen.from, to: req.to, cc: req.cc, bcc: req.bcc, subject: prefixed(source.subject, 'Fwd'),
      ...(text ? { text } : {}), ...(html ? { html } : {}),
      forwardAttachmentsFrom: source.id, verifiedSource: source,
    },
    fromIsDefault: chosen.isDefault,
    sourceAddress: source.address,
  };
}
