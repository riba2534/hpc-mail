import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
// @ts-expect-error Vite 的 ?raw 导入（只用于源码结构断言）
import source from '../src/constants.ts?raw';
import * as constants from '../src/constants.js';
import * as root from '../src/index.js';

/**
 * `@hpc-mail/shared/constants` 是前端首屏取运行时常量的入口：/inbox 等关键路径只为一个常量
 * 就静态引入主入口，会把全部 zod schema 拉进首屏。这个入口必须保持零依赖。
 */
describe('@hpc-mail/shared/constants 子路径', () => {
  it('constants.ts 不 import 任何模块（不能间接带上 zod）', () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\b/m);
    expect(source.length).toBeGreaterThan(100);
  });

  it('package.json 导出 ./constants，且与主入口导出的是同一批值', () => {
    expect((pkg.exports as Record<string, string>)['./constants']).toBe('./src/constants.ts');
    for (const [name, value] of Object.entries(constants)) {
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
    expect(constants.UNREAD_COUNT_CAP).toBeGreaterThan(0);
  });
});
