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
  const cidLinks = new Map(links.filter(link => link.contentId)
    .map(link => [link.contentId!.replace(/^<|>$/g, ''), link.url]));
  const linkedHtml = html.replace(/cid:([^\s"'<>]+)/gi, (original, cid: string) => {
    let decoded = cid;
    try { decoded = decodeURIComponent(cid); } catch { /* 保留原始 CID。 */ }
    return cidLinks.get(decoded) ?? original;
  });
  return { text: text ? text + textBlock : '', html: html ? linkedHtml + htmlBlock : '' };
}
