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

export interface AttachmentLink {
  filename: string;
  size: number;
  url: string;
  contentId?: string;
}

/**
 * 注入区块的固定写法。HTML 区块用注释标记包裹；纯文本不能加不可见标记，以固定标题行加
 * 「· 文件名 (大小): 链接」逐行列表为准（与上线前的写法相同）。补发、重发前据此剔除旧区块。
 */
const TEXT_TITLE = '— 附件下载（链接有效期 90 天）—';
const HTML_TITLE = '<br><p>— 附件下载（<em>链接有效期 90 天</em>）—</p>';
const HTML_START = '<!--hpc-mail:attachment-links-->';
const HTML_END = '<!--/hpc-mail:attachment-links-->';
const TEXT_BLOCK = /(?:\n\n)?— 附件下载（链接有效期 90 天）—((?:\n· [^\n]* \([^()\n]*\): \S+)+)/g;
const TEXT_LINE_URL = /\n· [^\n]* \([^()\n]*\): (\S+)/g;
const HTML_MARKED_BLOCK = /<!--hpc-mail:attachment-links-->([\s\S]*?)<!--\/hpc-mail:attachment-links-->/g;
/** 上线前没有标记的 HTML 区块：标题段落后紧跟只含下载链接的列表 */
const HTML_LEGACY_BLOCK = /<br><p>— 附件下载（<em>链接有效期 90 天<\/em>）—<\/p><ul>((?:<li><a href="[^"]*">[^<]*<\/a> \([^()<]*\)<\/li>)+)<\/ul>/g;
const HTML_HREF = /href="([^"]*)"/g;

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
  // 文件名里的换行会把一行拆成两行，剔除旧区块时就认不全
  const textBlock =
    `\n\n${TEXT_TITLE}\n` +
    links.map((l) => `· ${l.filename.replace(/[\u0000-\u001f\u007f]+/g, ' ')} (${fmtBytes(l.size)}): ${l.url}`).join('\n');
  const htmlBlock =
    `${HTML_START}${HTML_TITLE}<ul>` +
    links.map((l) => `<li><a href="${l.url}">${escapeHtml(l.filename)}</a> (${fmtBytes(l.size)})</li>`).join('') +
    `</ul>${HTML_END}`;
  const cidLinks = new Map(links.filter(link => link.contentId)
    .map(link => [link.contentId!.replace(/^<|>$/g, ''), link.url]));
  const linkedHtml = html.replace(/cid:([^\s"'<>]+)/gi, (original, cid: string) => {
    let decoded = cid;
    try { decoded = decodeURIComponent(cid); } catch { /* 保留原始 CID。 */ }
    return cidLinks.get(decoded) ?? original;
  });
  return { text: text ? text + textBlock : '', html: html ? linkedHtml + htmlBlock : '' };
}

/**
 * 剔除正文里本站注入的附件下载区块（带标记的新写法与上线前的旧写法）。只剔除链接全部指向
 * `origin` 的本站附件、且附件 id 都在 attachmentIds 里的区块——补发、重发会把这些附件重新带上，
 * 旧区块已经多余；用户自己写的内容、其他站点或其他邮件的下载区块原样保留。
 */
export function stripAttachmentLinks(
  text: string,
  html: string,
  origin: string,
  attachmentIds: ReadonlySet<number>,
): { text: string; html: string } {
  if (attachmentIds.size === 0) return { text, html };
  const ours = (urls: string[]) => urls.length > 0 && urls.every((raw) => {
    try {
      const url = new URL(raw.replace(/&amp;/g, '&'));
      const id = /^\/api\/attachments\/(\d+)$/.exec(url.pathname)?.[1];
      return url.origin === origin && id !== undefined && attachmentIds.has(Number(id));
    } catch {
      return false;
    }
  });
  const hrefs = (block: string) => [...block.matchAll(HTML_HREF)].map((match) => match[1]!);
  return {
    text: text.replace(TEXT_BLOCK, (block, lines: string) =>
      ours([...lines.matchAll(TEXT_LINE_URL)].map((match) => match[1]!)) ? '' : block),
    html: html
      .replace(HTML_MARKED_BLOCK, (block, inner: string) => (ours(hrefs(inner)) ? '' : block))
      .replace(HTML_LEGACY_BLOCK, (block, items: string) => (ours(hrefs(items)) ? '' : block)),
  };
}
