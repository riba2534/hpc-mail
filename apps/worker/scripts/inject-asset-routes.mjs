#!/usr/bin/env node
/**
 * 部署前为 dist/assets 下每个现存文件在 wrangler.toml 的 run_worker_first 里追加 `!/assets/<文件>`。
 *
 * Worker 配置了 placement 后会被固定在 D1 附近执行，若静态资源也先进 Worker，全球用户取 JS/CSS
 * 都要绕到新加坡。但不能直接删掉 "/assets/*"：数组形式下未匹配的缺失路径会走 SPA 回退返回
 * 200 text/html（线上已实测），旧版本页面请求已不存在的哈希文件时会拿到 HTML。
 * 所以保留原有正向规则，只把「确实存在」的文件排除出去（排除规则优先），缺失文件仍进 Worker 返回 404。
 *
 * - 幂等：先去掉旧的 `!/assets/` 条目再按当前文件重建，重复执行结果不变。
 * - Cloudflare 上限 100 条；总数超过 95 时不注入（回退为全部经 Worker），打印 warning。
 * - 文件名含 glob 元字符或引号等非常规字符时跳过该文件（仍经 Worker，行为安全）。
 *
 * 用法：node scripts/inject-asset-routes.mjs [--config wrangler.toml] [--assets dist/assets]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_RULES = 95;
const SAFE_NAME = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const ARRAY_PATTERN = /^(run_worker_first\s*=\s*)\[([^\]]*)\]/m;

/** 递归列出目录下的文件（相对路径，以 / 分隔） */
export function listAssetFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/** 纯函数：返回新的 toml 文本与统计；不改动 run_worker_first 以外的内容 */
export function injectAssetRoutes(toml, files, max = MAX_RULES) {
  const match = ARRAY_PATTERN.exec(toml);
  if (!match) throw new Error('wrangler.toml 中找不到 run_worker_first 数组');
  const entries = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const base = entries.filter((entry) => !entry.startsWith('!/assets/'));
  const exclusions = [...new Set(files.filter((file) => SAFE_NAME.test(file)))].map((file) => `!/assets/${file}`);
  const skipped = files.length - exclusions.length;
  let next = [...base, ...exclusions];
  let injected = exclusions.length;
  let overLimit = false;
  if (next.length > max) {
    overLimit = true;
    next = base;
    injected = 0;
  }
  const rendered = `${match[1]}[${next.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  return {
    toml: toml.slice(0, match.index) + rendered + toml.slice(match.index + match[0].length),
    total: next.length,
    injected,
    skipped,
    overLimit,
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const configPath = option('--config', join(root, 'wrangler.toml'));
  const assetsDir = option('--assets', join(root, 'dist', 'assets'));
  let files = [];
  try {
    files = listAssetFiles(assetsDir);
  } catch (error) {
    console.error(`::warning::读取 ${assetsDir} 失败（${error.message}），不注入静态资源排除规则`);
  }
  const result = injectAssetRoutes(readFileSync(configPath, 'utf8'), files);
  writeFileSync(configPath, result.toml);
  if (result.overLimit) {
    console.error(`::warning::静态资源 ${files.length} 个，加上原有规则超过 ${MAX_RULES} 条上限，未注入排除规则（/assets/* 全部经 Worker）`);
  }
  if (result.skipped) console.error(`::warning::${result.skipped} 个文件名含非常规字符，保持经 Worker`);
  console.log(`run_worker_first 共 ${result.total} 条，其中静态资源排除 ${result.injected} 条`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
