import { describe, expect, it } from 'vitest';
// @ts-expect-error 构建脚本是无类型声明的 .mjs
import { findViolations, staticImports } from '../scripts/check-bundle.mjs';

describe('构建断言：关键路径不静态依赖 zod', () => {
  it('只认静态 import / export-from，不把动态 import() 当依赖', () => {
    const code = 'import{a as b}from"./x-1.js";import"./side-2.js";export{c}from"./re-3.js";import*as d from"./ns-4.js";' +
      'const lazy=()=>import("./lazy-5.js");';
    expect(staticImports(code)).toEqual(['x-1.js', 'side-2.js', 're-3.js', 'ns-4.js']);
  });

  it('沿静态依赖找到含 zod 的 chunk 并给出引用链；只经动态 import 可达时不算', () => {
    const chunks = {
      'index-a.js': 'import{x}from"./shell-b.js";',
      'shell-b.js': 'import{y}from"./util-c.js";const l=()=>import("./src-z.js");',
      'util-c.js': 'export const y=1;',
      'inbox-d.js': 'import{y}from"./util-c.js";import{S}from"./src-z.js";',
      'src-z.js': 'class ZodError extends Error{}',
    };
    expect(findViolations(chunks, ['index-a.js'])).toEqual([]);
    expect(findViolations(chunks, ['index-a.js', 'inbox-d.js'])).toEqual([
      { root: 'inbox-d.js', chain: ['inbox-d.js', 'src-z.js'] },
    ]);
  });
});
