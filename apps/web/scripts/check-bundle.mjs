#!/usr/bin/env node
/**
 * 构建后断言：入口、app-shell 与 /inbox 页面 chunk 的静态依赖闭包里不能有 zod。
 *
 * zod 与全部 schema 在 @hpc-mail/shared 主入口的 chunk 里（gzip 约 37KB），首屏只需要其中几个常量。
 * 运行时常量要从零依赖的 `@hpc-mail/shared/constants` 子路径取；哪天有人在这些关键路径上又静态引入了
 * 主入口，这里会失败并打印引用链。只读 dist，不写任何文件。
 *
 * 用法：node scripts/check-bundle.mjs [--dist dist]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** 关键路径上的懒加载页面（chunk 文件名前缀）；入口从 index.html 读取 */
export const CRITICAL_CHUNKS = ['app-shell', 'inbox-page'];
/** zod 打包后保留的类名，用来识别含 zod 的 chunk */
const ZOD_MARKER = 'ZodError';
/** 静态 import / export-from（不含动态 import(...)） */
const STATIC_IMPORT = /\b(?:import|export)\s*(?:\{[^}]*\}|\*(?:\s*as\s*[\w$]+)?|[\w$]+(?:\s*,\s*\{[^}]*\})?)?\s*(?:from\s*)?["']\.\/([^"']+\.js)["']/g;

export function staticImports(code) {
  return [...code.matchAll(STATIC_IMPORT)].map((match) => match[1]);
}

/** 纯函数：chunks 为 { 文件名: 代码 }；返回违规列表（每项含根与引用链） */
export function findViolations(chunks, roots, marker = ZOD_MARKER) {
  const tainted = new Set(Object.keys(chunks).filter((name) => chunks[name].includes(marker)));
  const violations = [];
  for (const root of roots) {
    const parent = new Map([[root, null]]);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      if (tainted.has(current)) {
        const chain = [];
        for (let node = current; node !== null; node = parent.get(node)) chain.unshift(node);
        violations.push({ root, chain });
        break;
      }
      for (const dep of staticImports(chunks[current] ?? '')) {
        if (!parent.has(dep)) { parent.set(dep, current); queue.push(dep); }
      }
    }
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--dist');
  const dist = index >= 0 && args[index + 1] ? args[index + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const assets = join(dist, 'assets');
  const chunks = Object.fromEntries(readdirSync(assets).filter((name) => name.endsWith('.js'))
    .map((name) => [name, readFileSync(join(assets, name), 'utf8')]));
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/g)].map((match) => match[1]);
  const roots = [...entries];
  for (const prefix of CRITICAL_CHUNKS) {
    const found = Object.keys(chunks).filter((name) => name.startsWith(`${prefix}-`));
    if (found.length !== 1) {
      console.error(`::error::找不到唯一的 ${prefix} chunk（${found.length} 个），请同步更新 scripts/check-bundle.mjs`);
      process.exit(1);
    }
    roots.push(found[0]);
  }
  if (!entries.length) {
    console.error('::error::index.html 里找不到入口 script，请同步更新 scripts/check-bundle.mjs');
    process.exit(1);
  }
  if (!Object.values(chunks).some((code) => code.includes(ZOD_MARKER))) {
    console.error(`::error::产物里找不到含 ${ZOD_MARKER} 的 chunk，识别方式失效，请同步更新 scripts/check-bundle.mjs`);
    process.exit(1);
  }
  const violations = findViolations(chunks, roots);
  for (const { root, chain } of violations) {
    console.error(`::error::${root} 静态依赖了含 zod 的 chunk：${chain.join(' → ')}。` +
      '首屏只取常量时请从 @hpc-mail/shared/constants 导入，或改为动态 import()');
  }
  if (violations.length) process.exit(1);
  const gzip = (name) => gzipSync(chunks[name]).byteLength;
  console.log(`关键路径不含 zod：${roots.map((name) => `${name}（gzip ${(gzip(name) / 1024).toFixed(1)}KB）`).join('，')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
