import { Lexer, type Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import skillDoc from '../../../public/skill.md?raw';
import { docForPath, docRoute, ENTRY_DOC, findDoc, REFERENCE_DOCS } from './docs-manifest';
import { stripFrontmatter } from './render-doc';

const referenceFiles = import.meta.glob<string>('../../../public/references/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const references = Object.fromEntries(
  Object.entries(referenceFiles).map(([path, content]) => [path.slice(path.lastIndexOf('/') + 1, -'.md'.length), content]),
);

const firstH1 = (markdown: string) =>
  Lexer.lex(stripFrontmatter(markdown).body).find(
    (token): token is Tokens.Heading => token.type === 'heading' && token.depth === 1,
  )?.text;

describe('API 文档清单与 public 目录一致', () => {
  it('登记了 public/references 下的每个文件，且没有多余条目', () => {
    expect(Object.keys(references).length).toBeGreaterThan(0);
    expect(REFERENCE_DOCS.map((doc) => doc.slug).sort()).toEqual(Object.keys(references).sort());
  });

  it('目录标题取各文件第一个一级标题', () => {
    expect(ENTRY_DOC.title).toBe(firstH1(skillDoc));
    for (const doc of REFERENCE_DOCS) expect(doc.title, doc.slug).toBe(firstH1(references[doc.slug]!));
  });

  it('路由与原文路径互相对应', () => {
    expect(findDoc(undefined)).toBe(ENTRY_DOC);
    expect(docRoute(ENTRY_DOC)).toBe('/api-docs');
    expect(findDoc('nope')).toBeUndefined();
    expect(docForPath('/skill.md')).toBe(ENTRY_DOC);
    for (const doc of REFERENCE_DOCS) {
      expect(doc.path).toBe(`/references/${doc.slug}.md`);
      expect(findDoc(doc.slug)).toBe(doc);
      expect(docForPath(doc.path)).toBe(doc);
      expect(docRoute(doc)).toBe(`/api-docs/${doc.slug}`);
    }
  });
});
