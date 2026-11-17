import { describe, expect, it } from 'vitest';
import skillDoc from '../../../public/skill.md?raw';
import { type ApiDoc, docForPath, ENTRY_DOC, findDoc, REFERENCE_DOCS } from './docs-manifest';
import { renderDoc, resolveDocLink, slugify, stripFrontmatter } from './render-doc';

const SITE = 'https://hpc.test';
const mailDoc = findDoc('mail')!;

const referenceFiles = import.meta.glob<string>('../../../public/references/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sources = new Map<ApiDoc, string>([[ENTRY_DOC, skillDoc]]);
for (const [path, content] of Object.entries(referenceFiles)) {
  const doc = docForPath(`/references/${path.slice(path.lastIndexOf('/') + 1)}`);
  if (doc) sources.set(doc, content);
}

function fragment(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

const decoded = (href: string) => decodeURI(href);

describe('stripFrontmatter', () => {
  it('去掉开头的 YAML frontmatter，description 作为简介', () => {
    const result = stripFrontmatter('---\nname: hpc-mail\ndescription: 收发邮件的说明\n---\n\n# 标题\n');
    expect(result).toEqual({ body: '\n# 标题\n', description: '收发邮件的说明' });
    expect(stripFrontmatter('---\ndescription: "带引号"\n---\n正文').description).toBe('带引号');
  });

  it('没有 frontmatter 时原样返回；正文中间的分隔线不当作 frontmatter', () => {
    const markdown = '# 标题\n\n---\n\ndescription: 不是元数据\n';
    expect(stripFrontmatter(markdown)).toEqual({ body: markdown, description: null });
  });

  it('skill.md 去掉 frontmatter 后以一级标题开头', () => {
    const { body, description } = stripFrontmatter(skillDoc);
    expect(body.trimStart().startsWith('# HPC Mail')).toBe(true);
    expect(description).toContain('HPC Mail');
  });
});

describe('slugify', () => {
  it('GitHub 风格：小写、去标点、保留中文/字母/数字/下划线/连字符，空白变连字符', () => {
    expect(slugify('管理员 Key 运维接口')).toBe('管理员-key-运维接口');
    expect(slugify('能力地图（路径相对 `/v1`）')).toBe('能力地图路径相对-v1');
    expect(slugify('释放、历史与共享边界')).toBe('释放历史与共享边界');
    expect(slugify('validation_failed')).toBe('validation_failed');
    expect(slugify('key-restricted')).toBe('key-restricted');
    expect(slugify('① 等验证码或验证链接')).toBe('①-等验证码或验证链接');
    expect(slugify('Webhook v2：事件推送')).toBe('webhook-v2事件推送');
  });
});

describe('resolveDocLink', () => {
  it('入口里的 references/x.md 与锚点改成站内路由', () => {
    expect(resolveDocLink('references/mail.md', ENTRY_DOC, SITE)).toEqual({ kind: 'route', href: '/api-docs/mail' });
    const link = resolveDocLink('references/administration.md#管理员-key-运维接口', ENTRY_DOC, SITE);
    expect(link?.kind).toBe('route');
    expect(decoded(link!.href)).toBe('/api-docs/administration#管理员-key-运维接口');
  });

  it('参考文档里的 ../skill.md、同目录文件、纯锚点与站内绝对路径', () => {
    expect(resolveDocLink('../skill.md', mailDoc, SITE)).toEqual({ kind: 'route', href: '/api-docs' });
    expect(resolveDocLink('errors.md#key-restricted', mailDoc, SITE)).toEqual({
      kind: 'route',
      href: '/api-docs/errors#key-restricted',
    });
    expect(resolveDocLink('#发送', mailDoc, SITE)?.href).toBe(`/api-docs/mail#${encodeURIComponent('发送')}`);
    expect(resolveDocLink('/references/mcp.md', ENTRY_DOC, SITE)).toEqual({ kind: 'route', href: '/api-docs/mcp' });
    expect(resolveDocLink('/skill.md#30-秒上手', mailDoc, SITE)?.kind).toBe('route');
  });

  it('外站链接与站内非文档资源新标签打开', () => {
    expect(resolveDocLink('https://example.com/a?b=1#c', ENTRY_DOC, SITE)).toEqual({
      kind: 'tab',
      href: 'https://example.com/a?b=1#c',
    });
    expect(resolveDocLink('//evil.example/x', ENTRY_DOC, SITE)).toEqual({ kind: 'tab', href: 'https://evil.example/x' });
    expect(resolveDocLink('/v1/openapi.json', ENTRY_DOC, SITE)).toEqual({ kind: 'tab', href: '/v1/openapi.json' });
    // 未登记的 .md 不进路由（会是 404），直接打开原文
    expect(resolveDocLink('new-topic.md', mailDoc, SITE)).toEqual({ kind: 'tab', href: '/references/new-topic.md' });
  });

  it('只放行 http/https 与站内相对链接', () => {
    for (const href of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>',
      'vbscript:x', 'mailto:a@example.com', 'ftp://example.com/x', 'http://[bad']) {
      expect(resolveDocLink(href, ENTRY_DOC, SITE), href).toBeNull();
    }
  });
});

describe('renderDoc', () => {
  it('渲染 Markdown：标题带锚点（重复标题加序号），frontmatter 去掉，简介放在一级标题后', () => {
    const { html, title } = renderDoc(
      '---\nname: x\ndescription: 这是简介\n---\n# 入口\n\n## 发送\n\n正文 **加粗**\n\n## 发送\n\n### Key 与 `scope`\n',
      ENTRY_DOC,
    );
    const root = fragment(html);
    expect(title).toBe('入口');
    expect(html).not.toContain('name: x');
    const headings = [...root.querySelectorAll('h1, h2, h3')].map((heading) => [heading.tagName, heading.id]);
    expect(headings).toEqual([['H1', '入口'], ['H2', '发送'], ['H2', '发送-1'], ['H3', 'key-与-scope']]);
    expect(root.querySelector('h1')?.nextElementSibling?.textContent).toBe('这是简介');
    expect(root.querySelector('strong')?.textContent).toBe('加粗');
  });

  it('链接改写：站内文档走路由，外部新标签打开，危险协议去掉 href', () => {
    const root = fragment(renderDoc(
      '[邮件](references/mail.md#发送) [外站](https://example.com) [规格](/v1/openapi.json) [坏](javascript:alert(1)) <a href="JAVASCRIPT:alert(2)">坏2</a>',
      ENTRY_DOC,
    ).html);
    const link = (text: string) => [...root.querySelectorAll('a')].find((anchor) => anchor.textContent === text)!;
    expect(decoded(link('邮件').getAttribute('href')!)).toBe('/api-docs/mail#发送');
    expect(link('邮件').hasAttribute('data-doc-route')).toBe(true);
    expect(link('邮件').hasAttribute('target')).toBe(false);
    for (const text of ['外站', '规格']) {
      expect(link(text).getAttribute('target')).toBe('_blank');
      expect(link(text).getAttribute('rel')).toBe('noopener noreferrer');
      expect(link(text).hasAttribute('data-doc-route')).toBe(false);
    }
    expect(link('外站').getAttribute('href')).toBe('https://example.com/');
    expect(link('规格').getAttribute('href')).toBe('/v1/openapi.json');
    for (const text of ['坏', '坏2']) expect(link(text).hasAttribute('href')).toBe(false);
    expect(root.querySelectorAll('[href*="script:" i]')).toHaveLength(0);
  });

  it('清洗原始 HTML：脚本、事件属性、样式与表单都去掉', () => {
    const { html } = renderDoc(
      '<script>alert(1)</script><img src="x.png" onerror="alert(1)"><p style="color:red" onclick="x()">段落</p>' +
        '<form action="/x"><input name="a"></form><iframe src="https://example.com"></iframe>\n',
      mailDoc,
    );
    const root = fragment(html);
    expect(root.querySelector('script, iframe, form, input, style')).toBeNull();
    expect(html).not.toMatch(/onerror|onclick|style=/);
    expect(root.querySelector('p')?.textContent).toBe('段落');
    // 相对图片按原文位置解析
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/references/x.png');
  });

  it('表格包一层可横向滚动的容器，代码块等宽可滚动，行内代码有底色', () => {
    const root = fragment(renderDoc('| a | b |\n|---|---|\n| `x` | y |\n\n```bash\ncurl -s "$API/me"\n```\n', mailDoc).html);
    const table = root.querySelector('table')!;
    expect(table.parentElement?.className).toContain('overflow-x-auto');
    const pre = root.querySelector('pre')!;
    expect(pre.className).toContain('overflow-x-auto');
    expect(pre.querySelector('code')?.className).toBe('font-mono');
    expect(pre.textContent).toBe('curl -s "$API/me"\n');
    const inline = table.querySelector('code')!;
    expect(inline.className).toContain('bg-surface-active');
    expect(inline.className).toContain('font-mono');
  });
});

describe('真实文档的锚点', () => {
  const rendered = new Map([...sources].map(([doc, markdown]) => [doc, fragment(renderDoc(markdown, doc).html)]));

  it('读到了入口与全部参考文档', () => {
    expect(sources.size).toBe(1 + REFERENCE_DOCS.length);
  });

  it('每个标题都有锚点 id，没有被清洗掉', () => {
    for (const [doc, root] of rendered) {
      const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      expect(headings.length, doc.path).toBeGreaterThan(0);
      for (const heading of headings) expect(heading.id, `${doc.path}: ${heading.textContent}`).not.toBe('');
    }
  });

  it('文档里每个相对链接都变成站内路由，且 #锚点 能在目标文档的标题里找到', () => {
    let checked = 0;
    const broken: string[] = [];
    for (const [doc, markdown] of sources) {
      const relative = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1]!)
        .filter((target) => !/^[a-z]+:/i.test(target));
      const routes = [...rendered.get(doc)!.querySelectorAll('a[data-doc-route]')].map((anchor) => anchor.getAttribute('href')!);
      expect(routes.length, doc.path).toBe(relative.length);
      for (const href of routes) {
        const [path, hash = ''] = href.split('#') as [string, string | undefined];
        const target = findDoc(path === '/api-docs' ? undefined : path.slice('/api-docs/'.length));
        const id = decodeURIComponent(hash);
        checked += 1;
        if (!target) broken.push(`${doc.path}: ${href}`);
        else if (id && !rendered.get(target)!.getElementById(id)) broken.push(`${doc.path}: ${decodeURI(href)}`);
      }
    }
    expect(broken).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });
});
