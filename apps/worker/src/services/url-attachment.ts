import {
  MAX_ATTACHMENT_FILE_BYTES,
  SINGLE_UPLOAD_THRESHOLD_BYTES,
  URL_ATTACHMENT_MAX_REDIRECTS,
  URL_ATTACHMENT_TIMEOUT_MS,
  attachmentFilenameSchema,
  type UrlAttachment,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { attachmentDisposition, type StoredAttachment } from './outbound.js';
import { consumeDraftAttachments, draftKey, newDraftToken, releaseDraftStatements, reserveDraftAttachment } from './upload.js';

/** 拉取并转存后的 URL 附件：token 是转存出的上传附件（draft_attachments 行），发送成功后与 attachmentTokens 一起回收 */
export interface FetchedUrlAttachment extends StoredAttachment {
  token: string;
}

export interface UrlFetchOptions {
  /** 本站自身的主机名（请求的 Host、env.site_origin 的主机），不允许拉取 */
  selfHosts: string[];
  /** 本次请求还能容纳的附件字节数（MAX_ATTACHMENT_TOTAL_BYTES 减去其他附件） */
  budgetBytes: number;
  /** 转存出的附件直接被这个服务端草稿引用（draft_attachments.draft_id） */
  draftId?: number;
  /** 单个附件的拉取总时限（含 DNS 与重定向）；测试用，默认 URL_ATTACHMENT_TIMEOUT_MS */
  timeoutMs?: number;
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const USER_AGENT = 'HPC-Mail-Attachment-Fetcher/1.0';

const FORBIDDEN_FIX = '只能引用公网可访问的 https 地址；内网或本站的文件先下载，再用 POST /v1/uploads（网页会话用 /api/uploads）上传后写进 attachmentTokens';
const FETCH_FIX = '确认地址能公开访问（预签名链接未过期、不需要登录），或先下载再用 POST /v1/uploads（网页会话用 /api/uploads）上传后写进 attachmentTokens';

function forbidden(url: string, reason: string): AppError {
  return new AppError('attachment_url_forbidden', `附件地址不允许：${reason}`, {
    fix: FORBIDDEN_FIX, docs: '/references/errors.md#attachment_url_forbidden', details: { url },
  });
}

function fetchFailed(url: string, reason: string): AppError {
  return new AppError('attachment_url_fetch_failed', `附件拉取失败：${reason}`, {
    fix: FETCH_FIX, docs: '/references/errors.md#attachment_url_fetch_failed', details: { url },
  });
}

// ---------- IP 地址判定（纯函数，导出供单测） ----------

/** 点分十进制 IPv4 → 4 个八位组；不是严格的点分十进制返回 null（URL 解析器已把 0x7f.1 等写法规范成点分十进制） */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : null;
}

/** 内网、回环、链路本地（含云元数据 169.254.169.254）、CGNAT、保留、文档、基准测试、组播与广播网段 */
export function isForbiddenIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** IPv6 文本（可带方括号、可含末尾点分 IPv4）→ 8 个 16 位组；非法返回 null */
export function parseIPv6(value: string): number[] | null {
  let text = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (text.includes('%')) return null; // 带 zone id 的链路本地地址
  const tail: number[] = [];
  const v4Match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[2]!);
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    text = v4Match[1]!.endsWith('::') ? v4Match[1]! : v4Match[1]!.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((group) => Number.isNaN(group))) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  return [...head, ...Array(8 - explicit).fill(0), ...rest, ...tail];
}

/**
 * 只放行全球单播 2000::/3 中的公网段；IPv4 映射（::ffff:0:0/96）、IPv4 兼容（::/96）、NAT64（64:ff9b::/96）
 * 与 6to4（2002::/16）按其中嵌入的 IPv4 判断。Teredo、ORCHID 等 2001::/23 协议段与文档段 2001:db8::/32 一律拒绝。
 */
export function isForbiddenIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => isForbiddenIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return embedded(g6, g7);
    if (g5 === 0) return (g6 === 0 && g7 <= 1) || embedded(g6, g7);
    return true;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
  if (g0 === 0x2002) return embedded(g1, g2);
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && g1 < 0x0200) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return false;
}

/** IP 文本落在禁止网段（或无法解析）时为 true */
export function isForbiddenAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isForbiddenIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isForbiddenIPv6(v6) : true;
}

// ---------- URL 与主机检查 ----------

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/** 协议、账号密码、端口与主机名的静态检查；返回规范化的主机名（IPv6 去方括号） */
function checkUrl(url: URL, selfHosts: string[]): string {
  const shown = url.toString();
  if (url.protocol !== 'https:') throw forbidden(shown, '只允许 https');
  if (url.username || url.password) throw forbidden(shown, '地址里不能带账号密码');
  if (url.port && url.port !== '443') throw forbidden(shown, '只允许默认端口 443');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    if (isForbiddenAddress(host)) throw forbidden(shown, '内网、回环、链路本地或保留地址');
    return host.slice(1, -1);
  }
  if (parseIPv4(host)) {
    if (isForbiddenAddress(host)) throw forbidden(shown, '内网、回环、链路本地或保留地址');
    return host;
  }
  if (!host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw forbidden(shown, '内网主机名');
  }
  for (const self of selfHosts) {
    const name = self.toLowerCase().replace(/\.$/, '');
    if (name && (host === name || host.endsWith(`.${name}`))) throw forbidden(shown, '不能引用本站自身的地址');
  }
  return host;
}

interface DohAnswer { type: number; data: string }

/** 单个附件的拉取时限：DNS、每一跳请求与读取内容共用 */
interface Deadline { signal: AbortSignal; message: string }

/**
 * 经 DoH 解析 A 与 AAAA：任一地址落在禁止网段即拒绝，一个地址都没有算拉取失败。
 * Workers 没有本地解析接口，也不能把连接钉在解析出的 IP 上；随后的 fetch 由 Cloudflare 网络自行解析，
 * 而 Workers 的出站请求本身到不了私网地址，这一层用来拒绝明确解析到内网/元数据地址的域名。
 */
async function assertPublicHost(host: string, shown: string, deadline: Deadline): Promise<void> {
  const { signal } = deadline;
  if (parseIPv4(host) || host.includes(':')) return; // IP 字面量已在 checkUrl 判定
  const lookups = await Promise.all([1, 28].map(async (type) => {
    try {
      const response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' }, signal,
      });
      if (!response.ok) return null;
      return await response.json() as { Status?: number; Answer?: DohAnswer[] };
    } catch (error) {
      if (signal.aborted) throw fetchFailed(shown, deadline.message);
      console.error('附件地址 DNS 解析失败:', error);
      return null;
    }
  }));
  if (lookups.every((lookup) => lookup === null)) throw fetchFailed(shown, 'DNS 解析失败');
  const addresses = lookups.flatMap((lookup) => (lookup?.Answer ?? []).filter((answer) => answer.type === 1 || answer.type === 28)
    .map((answer) => answer.data.trim()));
  if (!addresses.length) throw fetchFailed(shown, '域名解析不到任何地址');
  if (addresses.some(isForbiddenAddress)) throw forbidden(shown, '域名解析到内网、回环、链路本地或保留地址');
}

/** 手动跟随重定向，每一跳都重新做 URL、主机与 DNS 检查；返回最终的 2xx 响应 */
async function fetchFollowing(start: string, selfHosts: string[], deadline: Deadline): Promise<{ response: Response; url: URL }> {
  const { signal } = deadline;
  let current: URL;
  try { current = new URL(start); } catch { throw forbidden(start, '不是合法的地址'); }
  for (let hop = 0; ; hop++) {
    const shown = current.toString();
    const host = checkUrl(current, selfHosts);
    await assertPublicHost(host, shown, deadline);
    let response: Response;
    try {
      // workerd 不支持 redirect: 'error'，用 manual 自己判定每一跳
      response = await fetch(shown, {
        method: 'GET', redirect: 'manual', signal,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' },
      });
    } catch {
      throw fetchFailed(shown, signal.aborted ? deadline.message : '连接失败');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw fetchFailed(shown, `HTTP ${response.status} 没有给出跳转地址`);
      if (hop >= URL_ATTACHMENT_MAX_REDIRECTS) throw fetchFailed(shown, `重定向超过 ${URL_ATTACHMENT_MAX_REDIRECTS} 次`);
      try { current = new URL(location, current); } catch { throw fetchFailed(shown, '跳转地址不合法'); }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fetchFailed(shown, `HTTP ${response.status}`);
    }
    return { response, url: current };
  }
}

/** Content-Disposition 里的文件名：优先 RFC 5987 的 filename*，其次 filename */
function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try { return decodeURIComponent(extended[2]!.trim().replace(/^"|"$/g, '')); } catch { /* 落到 filename */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]!).trim() : undefined;
}

function pathFilename(url: URL): string | undefined {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return undefined;
  try { return decodeURIComponent(last); } catch { return last; }
}

/** 文件名：请求给的 → Content-Disposition → URL 路径末段；不合法的去掉路径分隔符与 ..，仍不合法回退 attachment */
function pickFilename(requested: string | undefined, response: Response, url: URL): string {
  if (requested) return requested;
  for (const candidate of [dispositionFilename(response.headers.get('content-disposition')), pathFilename(url)]) {
    if (!candidate) continue;
    const cleaned = candidate.replace(/[/\\]/g, '_').replace(/\.\.+/g, '.').replace(/[\r\n\t]/g, ' ').trim().slice(0, 255);
    if (attachmentFilenameSchema.safeParse(cleaned).success) return cleaned;
  }
  return 'attachment';
}

function pickMimeType(requested: string | undefined, response: Response): string {
  if (requested) return requested;
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 128 ? type : 'application/octet-stream';
}

/** 没有 Content-Length（或经过压缩、长度不可信）时边读边计数，最多缓冲 cap 字节 */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number, shown: string): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new AppError('payload_too_large', `附件超过 ${Math.floor(cap / 1024 / 1024)}MiB 上限（没有 Content-Length 的响应最多 ${SINGLE_UPLOAD_THRESHOLD_BYTES / 1024 / 1024}MiB）`, {
        details: { url: shown },
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** 拉取一个 URL 附件并转存；失败时自己占用的行（若有）登记清理后再抛错 */
async function fetchOne(env: Env, userId: number, item: UrlAttachment, options: UrlFetchOptions, budget: number): Promise<FetchedUrlAttachment> {
  const timeoutMs = options.timeoutMs ?? URL_ATTACHMENT_TIMEOUT_MS;
  const deadline: Deadline = { signal: AbortSignal.timeout(timeoutMs), message: `超过 ${Math.round(timeoutMs / 1000)} 秒未完成` };
  const { signal } = deadline;
  const { response, url } = await fetchFollowing(item.url, options.selfHosts, deadline);
  const shown = url.toString();
  const limit = Math.min(MAX_ATTACHMENT_FILE_BYTES, budget);
  const tooLarge = () => new AppError('payload_too_large',
    limit < MAX_ATTACHMENT_FILE_BYTES ? '附件合计超过大小上限' : `单个附件超过 ${MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024}MiB 上限`,
    { details: { url: shown } });
  const encoded = (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity';
  const declaredHeader = response.headers.get('content-length');
  const declared = !encoded && declaredHeader !== null && /^\d+$/.test(declaredHeader.trim()) ? Number(declaredHeader) : null;
  if (declared !== null && declared > limit) { await response.body?.cancel(); throw tooLarge(); }
  if (declared === 0 || !response.body) { await response.body?.cancel(); throw fetchFailed(shown, '内容为空'); }
  const filename = pickFilename(item.filename, response, url);
  const mimeType = pickMimeType(item.contentType, response);

  // 长度已知时直接流式写 R2（FixedLengthStream 在实际字节数与声明不符时报错）；未知时先有上限地读进内存
  let bytes: Uint8Array | null = null;
  if (declared === null) {
    try { bytes = await readCapped(response.body, Math.min(limit, SINGLE_UPLOAD_THRESHOLD_BYTES), shown); }
    catch (error) {
      if (error instanceof AppError && error.code === 'payload_too_large' && limit < SINGLE_UPLOAD_THRESHOLD_BYTES) throw tooLarge();
      if (error instanceof AppError) throw error;
      throw fetchFailed(shown, signal.aborted ? deadline.message : '读取内容中断');
    }
    if (!bytes.byteLength) throw fetchFailed(shown, '内容为空');
  }
  const size = declared ?? bytes!.byteLength;
  const token = newDraftToken();
  const r2Key = draftKey(userId, token);
  let rowId: number;
  try {
    rowId = await reserveDraftAttachment(env, { userId, token, filename, mimeType, size, r2Key });
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  try {
    if (bytes) {
      await env.r2.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
    } else {
      const { readable, writable } = new FixedLengthStream(size);
      const piping = response.body.pipeTo(writable);
      const [stored] = await Promise.all([env.r2.put(r2Key, readable, { httpMetadata: { contentType: mimeType } }), piping]);
      if (!stored || stored.size !== size) throw new Error('写入大小与 Content-Length 不一致');
    }
    await env.db.prepare(`UPDATE draft_attachments SET status = 'ready', draft_id = ? WHERE id = ?`)
      .bind(options.draftId ?? null, rowId).run();
  } catch (error) {
    await env.db.batch(releaseDraftStatements(env, [rowId]))
      .catch((cleanupError) => console.error('URL 附件转存失败后的清理登记失败:', cleanupError));
    if (error instanceof AppError) throw error;
    throw fetchFailed(shown, signal.aborted ? deadline.message : '读取或保存内容失败');
  }
  return {
    filename, mimeType, size, r2Key, token,
    contentId: item.contentId ?? '',
    disposition: attachmentDisposition(item),
  };
}

/**
 * 拉取 URL 附件并转存为上传附件（status=ready，计入每人待发送附件配额），按 items 顺序返回。
 * 只允许 https；DNS/IP 两层防 SSRF；限制大小、超时与重定向次数。逐个拉取，前面的占用计入后面的预算。
 * 失败时清理本次已转存的部分并抛 attachment_url_forbidden / attachment_url_fetch_failed / payload_too_large / rate_limited。
 */
export async function fetchUrlAttachments(
  env: Env,
  userId: number,
  items: UrlAttachment[],
  options: UrlFetchOptions,
): Promise<FetchedUrlAttachment[]> {
  const fetched: FetchedUrlAttachment[] = [];
  let budget = options.budgetBytes;
  try {
    for (const item of items) {
      if (budget <= 0) throw new AppError('payload_too_large', '附件合计超过大小上限', { details: { url: item.url } });
      const attachment = await fetchOne(env, userId, item, options, budget);
      fetched.push(attachment);
      budget -= attachment.size;
    }
  } catch (error) {
    if (fetched.length) await releaseUrlAttachments(env, userId, fetched);
    throw error;
  }
  return fetched;
}

/** 释放转存出的附件（删行并登记对象清理）；发送失败或草稿保存失败时调用，失败留给 24h 的上传附件过期清理兜底 */
export async function releaseUrlAttachments(env: Env, userId: number, attachments: { token: string }[]): Promise<void> {
  await consumeDraftAttachments(env, userId, attachments.map((attachment) => attachment.token))
    .catch((error) => console.error('URL 附件释放失败:', error));
}
