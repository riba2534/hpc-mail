import { cleanMailLink, protectMailText } from '@hpc-mail/shared';
import { defaultTreeAdapter, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { escapeHtml, htmlToText } from '../lib/text.js';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const MAX_NESTING = 100;
const ELEMENTS = new Set([
  'a', 'address', 'article', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col',
  'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'li', 'main',
  'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'wbr',
]);
const VOID = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const DISCARD = new Set([
  'applet', 'audio', 'base', 'embed', 'frame', 'frameset', 'head', 'iframe', 'link', 'meta',
  'noscript', 'object', 'script', 'style', 'template', 'title', 'video', 'xmp',
]);
const LAYOUT_ATTRIBUTES = new Set([
  'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'dir',
  'height', 'lang', 'rowspan', 'scope', 'valign', 'width',
]);

export function safeMailContentId(value: string): string | null {
  const id = value.replace(/^<|>$/g, '');
  return /^[\x21-\x3b\x3d\x3f-\x7e]{1,254}$/.test(id) ? id : null;
}

function imageCid(source: string | undefined, allowedIds: ReadonlySet<string>): string | null {
  if (!source || !/^cid:/i.test(source)) return null;
  try {
    const id = safeMailContentId(decodeURIComponent(source.slice(4)));
    return id && allowedIds.has(id) ? 'cid:' + encodeURIComponent(id) : null;
  } catch {
    return null;
  }
}

type Node = DefaultTreeAdapterTypes.ChildNode;

function protectedHtml(html: string, allowedIds: ReadonlySet<string>): string {
  const fragment = parseFragment(html);
  const result: string[] = [];
  function write(nodes: readonly Node[], depth: number): void {
    if (depth > MAX_NESTING) throw new Error('Mail HTML exceeds allowed nesting');
    for (const node of nodes) {
      if (defaultTreeAdapter.isTextNode(node)) {
        result.push(escapeHtml(protectMailText(node.value)));
        continue;
      }
      if (!defaultTreeAdapter.isElementNode(node) || node.namespaceURI !== HTML_NAMESPACE
        || DISCARD.has(node.tagName)) continue;
      const tag = node.tagName;
      if (!ELEMENTS.has(tag)) {
        write(node.childNodes, depth + 1);
        continue;
      }
      const attrs = new Map(node.attrs.filter(attr => !attr.namespace).map(attr => [attr.name, attr.value]));
      const src = tag === 'img' ? imageCid(attrs.get('src'), allowedIds) : null;
      if (tag === 'img' && !src) {
        const alt = attrs.get('alt');
        if (alt) result.push(escapeHtml(protectMailText(alt)));
        continue;
      }
      const href = tag === 'a' ? cleanMailLink(attrs.get('href') ?? '') : null;
      result.push('<' + tag);
      if (src) result.push(' src="' + escapeHtml(src) + '"');
      if (href) result.push(' href="' + escapeHtml(href) + '" rel="noopener noreferrer"');
      for (const [name, value] of attrs) {
        if (LAYOUT_ATTRIBUTES.has(name) || (name === 'alt' && tag === 'img')) {
          result.push(' ' + name + '="' + escapeHtml(protectMailText(value)) + '"');
        }
      }
      result.push('>');
      if (VOID.has(tag)) continue;
      write(node.childNodes, depth + 1);
      result.push('</' + tag + '>');
    }
  }
  write(fragment.childNodes, 0);
  return result.join('');
}

/** Generate both variants without resolving, fetching, or copying any remote resource. */
export async function protectMailBody(input: {
  text: string; html: string; inlineContentIds?: readonly string[];
}): Promise<{ text: string; html: string }> {
  const ids = new Set(input.inlineContentIds?.map(safeMailContentId).filter((id): id is string => id !== null));
  let html = '';
  if (input.html && input.html.length <= MAX_HTML_CHARS) {
    try {
      html = protectedHtml(input.html, ids);
    } catch {
      // The pure text converter keeps carry-over markup out of MIME on parser failure.
    }
  }
  return { text: protectMailText(input.text || htmlToText(html || input.html)), html };
}
