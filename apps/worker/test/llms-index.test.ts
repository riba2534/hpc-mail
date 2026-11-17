import { describe, expect, it } from 'vitest';
import llmsDoc from '../../web/public/llms.txt?raw';

/** 全部参考文档（新增文档会自动进入断言范围） */
const references = Object.keys(import.meta.glob('../../web/public/references/*.md'))
  .map((path) => `/references/${path.split('/').pop()}`);

describe('llms.txt 文档索引（D4）', () => {
  it('按 llmstxt 约定：H1、引用块摘要，最后一节是 Optional', () => {
    expect(llmsDoc).toMatch(/^# HPC Mail\n\n> /);
    const sections = [...llmsDoc.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(sections.at(-1)).toBe('Optional');
  });

  it('列出技能说明、两份 OpenAPI 与全部参考文档，每个链接只出现一次', () => {
    expect(references.length).toBeGreaterThanOrEqual(7);
    const links = [...llmsDoc.matchAll(/\]\((\/[^)\s]+)\)/g)].map((match) => match[1]!);
    for (const path of ['/skill.md', '/v1/openapi.json', '/api/openapi.json', ...references]) {
      expect(links.filter((link) => link === path), path).toHaveLength(1);
    }
  });
});
