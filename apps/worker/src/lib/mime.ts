/**
 * base64 按 RFC 2045 折行（76 字符 + CRLF）。
 * mimetext 的 dump 会把附件 data 原样拼进 MIME，不折行的话整个附件是一行，
 * 超出 SMTP/RFC 5322 单行 998 字节硬限，QQ 邮箱等严格 MTA 会静默拒收。
 */
export function foldBase64(b64: string): string {
  if (b64.length <= 76) return b64;
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    parts.push(b64.slice(i, i + 76));
  }
  return parts.join('\r\n');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 把正文编码成折行的 base64，配 `encoding: 'base64'` 使用。
 *
 * mimetext 的 dump 是 `headers + CRLF + CRLF + data` 原样拼接——`encoding` 选项只写进
 * Content-Transfer-Encoding 头，**不会真的编码数据**。默认的 7bit 有两个问题：
 * ① 一段不换行的中文超过约 330 字就突破 RFC 5322 的 998 字节行限（转发压成一行的营销
 *    邮件 HTML 更是几十 KB 一行），严格 MTA 会拒收——和附件 base64 不折行是同一类问题；
 * ② 声明 7bit 却塞 8-bit UTF-8 本身就不合规。
 */
export function encodeBodyBase64(s: string): string {
  return foldBase64(bytesToBase64(new TextEncoder().encode(s)));
}

/** base64 分段解码进同一块缓冲区：整串 atob 会多出一份与附件等长的二进制字符串 */
export function base64ToBytes(b64: string): Uint8Array {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor(((b64.length - padding) * 3) / 4));
  const step = 64 * 1024;
  let offset = 0;
  for (let i = 0; i < b64.length; i += step) {
    const binary = atob(b64.slice(i, i + step));
    for (let j = 0; j < binary.length; j++) out[offset + j] = binary.charCodeAt(j);
    offset += binary.length;
  }
  return out;
}

/** RFC 2047 encoded-word 不超过 75 字符，且每段都包含完整 UTF-8 字符。 */
export function encodeHeaderWords(value: string): string {
  const encoder = new TextEncoder();
  const words: string[] = [];
  let part = '';
  let size = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > 42 && part) {
      words.push(`=?utf-8?B?${bytesToBase64(encoder.encode(part))}?=`);
      part = '';
      size = 0;
    }
    part += character;
    size += bytes;
  }
  if (part) words.push(`=?utf-8?B?${bytesToBase64(encoder.encode(part))}?=`);
  return words.join(' ');
}

/**
 * 地址头里的一个 mailbox。mimetext 把任何显示名都写成 base64 encoded-word（纯 ASCII 也编码，
 * 垃圾邮件规则会因「不必要的 base64」扣分），所以 To/Cc/Reply-To 自己组装：
 * ASCII 显示名一律写成带引号的 quoted-string（转义 \ 与 "，逗号、括号等特殊字符因此不会被拆成多个地址），
 * 含非 ASCII 的写成 encoded-word。地址已严格校验、名称不含控制字符与尖括号，拼出的头不会被改写结构。
 */
export function formatMailbox(address: string, name: string): string {
  if (!name) return address;
  const phrase = /^[\x20-\x7e]+$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderWords(name);
  return `${phrase} <${address}>`;
}

export function formatAddressHeader(header: 'To' | 'Cc' | 'Reply-To', list: { address: string; name: string }[]): string {
  return `${header}: ${list.map((item) => formatMailbox(item.address, item.name)).join(', ')}`;
}

/** 头部取值里最长的不可折行片段（UTF-8 字节）：折行只能落在空白处，更长的片段无法满足 998 字节行限 */
export const MAX_HEADER_TOKEN_BYTES = 997;

export function hasUnfoldableToken(value: string): boolean {
  return value.split(/[ \t]+/).some((token) => new TextEncoder().encode(token).length > MAX_HEADER_TOKEN_BYTES);
}

/**
 * 非结构化头（X-*、Comments、Keywords、Organization、Thread-Topic）的取值：含非 ASCII、
 * 疑似 encoded-word（=?，原样写出会被收件端当成编码解释）或无法折行的超长片段时整体写成 encoded-word。
 */
export function encodeUnstructuredValue(value: string): string {
  return /[^\x20-\x7e\t]|=\?/.test(value) || hasUnfoldableToken(value) ? encodeHeaderWords(value) : value;
}

/** mimetext 不折行 Subject/References；发送前统一修复顶层头，不改 MIME 正文。 */
export function foldMimeHeaders(raw: string): string {
  const boundary = raw.indexOf('\r\n\r\n');
  if (boundary < 0) return raw;
  const headers = raw.slice(0, boundary).replace(/\r\n[ \t]+/g, ' ');
  const folded = headers.split('\r\n').map((header) => {
    const colon = header.indexOf(':');
    if (colon < 0) return header;
    const name = header.slice(0, colon + 1);
    const value = header.slice(colon + 1).trim().replace(
      /=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/gi,
      (word, encoded: string) => {
        // 结构化头里形似 encoded-word 却解不开的文本（如 URL 片段）原样保留，不能让整封信组装失败
        try { return encodeHeaderWords(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64ToBytes(encoded))); }
        catch { return word; }
      },
    );
    const lines: string[] = [];
    let line = name;
    for (const token of value.split(/[ \t]+/)) {
      if (new TextEncoder().encode(token).length > 997) throw new Error('邮件头字段过长');
      if (new TextEncoder().encode(`${line} ${token}`).length > 78) {
        lines.push(line);
        line = ` ${token}`;
      } else {
        line += ` ${token}`;
      }
    }
    lines.push(line);
    return lines.join('\r\n');
  }).join('\r\n');
  return folded + raw.slice(boundary);
}

/** 清洗后为空时的兜底文件名 */
const FALLBACK_FILENAME = 'attachment';

/**
 * 清洗 MIME 参数值（附件 filename / contentType）。
 *
 * mimetext 拼头是裸拼接——`Content-Disposition: attachment; filename="${value}"`，
 * 既不做 RFC 2047 编码也不转义引号和 CRLF。而入站转发路径的文件名完全由站外发件人控制：
 * postal-mime 解 RFC 2047 encoded-word / RFC 2231 续行后的值可以含裸 CRLF 和引号，
 * 足以在我们**代发**的邮件里改写 part 头结构（同一 part 出现两个 Content-Type，
 * 让扫描网关与收件客户端对内容类型的判定产生分歧）。
 *
 * 同时限长：转发路径对文件名长度没有上限，超长值会撑出 >998 字节的头行被下游 MTA 拒收。
 */
export function sanitizeMimeParam(value: string, maxLen = 200): string {
  return value.replace(/[\r\n\t"\\;]/g, '').slice(0, maxLen).trim();
}

/** 清洗附件文件名；清完为空则退回占位名（不能让 filename="" 进头） */
export function sanitizeFilename(value: string, maxLen = 200): string {
  return sanitizeMimeParam(value, maxLen) || FALLBACK_FILENAME;
}

/** 清洗 MIME 类型；非法则退回通用二进制类型 */
export function sanitizeMimeType(value: string): string {
  const cleaned = sanitizeMimeParam(value, 128);
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(cleaned)
    ? cleaned
    : 'application/octet-stream';
}
