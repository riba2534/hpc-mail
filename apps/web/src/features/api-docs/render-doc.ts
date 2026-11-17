import createDOMPurify from 'dompurify';
import { Marked } from 'marked';
import { type ApiDoc, docForPath, docRoute } from './docs-manifest';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** 去掉开头的 YAML frontmatter；其中单行的 description 作为简介返回 */
export function stripFrontmatter(markdown: string): { body: string; description: string | null } {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { body: markdown, description: null };
  const value = /^description:[ \t]*(.*)$/m.exec(match[1] ?? '')?.[1]?.trim() ?? '';
  return { body: markdown.slice(match[0].length), description: value.replace(/^(["'])(.*)\1$/, '$2') || null };
}

/**
 * 标题锚点，GitHub 风格：小写，去掉标点（保留中文、字母、数字、下划线和连字符），空白变连字符。
 * 与 worker 的文档链接测试（test/openapi-contract.test.ts）同一规则，文档里现有的 #锚点 都按它写。
 */
export function slugify(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

export type DocLink =
  /** 站内文档路由，客户端导航 */
  | { kind: 'route'; href: string }
  /** 外站链接或站内非文档资源（如 OpenAPI JSON），新标签打开 */
  | { kind: 'tab'; href: string };

/**
 * 解析文档里的链接：相对路径按原文所在位置解析（references/x.md 里的 ../skill.md 指向入口）。
 * 只放行 http/https 与站内相对链接，其余（javascript:、data:、mailto: 等）返回 null。
 */
export function resolveDocLink(href: string, doc: ApiDoc, origin: string): DocLink | null {
  let url: URL;
  try {
    url = new URL(href, origin + doc.path);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.origin !== origin) return { kind: 'tab', href: url.href };
  const target = url.search ? undefined : docForPath(url.pathname);
  if (target) return { kind: 'route', href: docRoute(target) + url.hash };
  return { kind: 'tab', href: url.pathname + url.search + url.hash };
}

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'details', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img',
  'kbd', 'li', 'ol', 'p', 'pre', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];
const ALLOWED_ATTR = ['align', 'alt', 'colspan', 'href', 'id', 'rowspan', 'src', 'start', 'title'];

/** 正文排版：只用设计系统已有的工具类，不为文档页新增全局样式 */
const CLASSES: Record<string, string> = {
  h1: 'mb-4 text-2xl font-semibold text-ink',
  h2: 'mt-8 mb-3 border-b border-line pb-1 text-lg font-semibold text-ink',
  h3: 'mt-5 mb-2 text-base font-semibold text-ink',
  h4: 'mt-4 mb-2 font-semibold text-ink',
  h5: 'mt-4 mb-2 font-semibold text-ink',
  h6: 'mt-4 mb-2 font-semibold text-ink-secondary',
  p: 'mb-3',
  ul: 'mb-3 list-disc pl-5',
  ol: 'mb-3 list-decimal pl-5',
  li: 'my-1',
  a: 'text-accent hover:underline',
  blockquote: 'mb-3 border-l-2 border-line-strong pl-4 text-ink-secondary',
  pre: 'mb-3 overflow-x-auto rounded-md border border-line bg-canvas p-3 text-xs leading-5',
  table: 'w-full text-left',
  th: 'border border-line bg-canvas px-3 py-2 font-semibold',
  td: 'border border-line px-3 py-2',
  hr: 'mt-5 mb-5 border-line',
  img: 'max-w-full',
};
const BLOCK_CODE_CLASS = 'font-mono';
const INLINE_CODE_CLASS = 'rounded bg-surface-active px-1 py-0.5 font-mono text-[13px]';
const TABLE_WRAPPER_CLASS = 'mb-3 overflow-x-auto';
const DESCRIPTION_CLASS = 'mb-3 rounded-lg border border-line bg-canvas px-4 py-3 text-ink-secondary';

function markdownToHtml(body: string): string {
  // github-slugger 的去重：重复的标题依次加 -1、-2
  const occurrences = new Map<string, number>();
  const uniqueSlug = (text: string) => {
    const base = slugify(text);
    let slug = base;
    while (occurrences.has(slug)) {
      const count = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        // 锚点按原文标题算（与文档链接测试一致）；slug 只含字母、数字、_ 与 -，可直接放进属性
        const slug = uniqueSlug(text);
        return `<h${depth}${slug ? ` id="${slug}"` : ''}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  return marked.parse(body, { async: false });
}

export interface RenderedDoc {
  html: string;
  /** 正文第一个一级标题 */
  title: string | null;
}

/** Markdown → 清洗后的 HTML：链接改写为站内路由或新标签打开，并加上正文排版样式 */
export function renderDoc(markdown: string, doc: ApiDoc, win: Window = window): RenderedDoc {
  const { body, description } = stripFrontmatter(markdown);
  const purifier = createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
  const clean = purifier.sanitize(markdownToHtml(body), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
  const origin = win.location.origin;
  const template = win.document.createElement('template');
  template.innerHTML = String(clean);
  const root = template.content;

  const resolve = (value: string | null) => (value === null ? null : resolveDocLink(value, doc, origin));
  root.querySelectorAll('a').forEach((anchor) => {
    const link = resolve(anchor.getAttribute('href'));
    if (!link) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('href', link.href);
    if (link.kind === 'route') {
      anchor.setAttribute('data-doc-route', '');
    } else {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  });
  root.querySelectorAll('img').forEach((image) => {
    const link = resolve(image.getAttribute('src'));
    if (link?.kind === 'tab') image.setAttribute('src', link.href);
    else image.remove();
  });
  root.querySelectorAll('table').forEach((table) => {
    const wrapper = win.document.createElement('div');
    wrapper.className = TABLE_WRAPPER_CLASS;
    table.replaceWith(wrapper);
    wrapper.append(table);
  });
  root.querySelectorAll('code').forEach((code) => {
    code.className = code.parentElement?.tagName === 'PRE' ? BLOCK_CODE_CLASS : INLINE_CODE_CLASS;
  });
  for (const [tag, className] of Object.entries(CLASSES)) {
    root.querySelectorAll(tag).forEach((element) => void (element.className = className));
  }

  const heading = root.querySelector('h1');
  if (description) {
    const intro = win.document.createElement('p');
    intro.className = DESCRIPTION_CLASS;
    intro.textContent = description;
    if (heading) heading.after(intro);
    else root.prepend(intro);
  }
  return { html: template.innerHTML, title: heading?.textContent?.trim() || null };
}
