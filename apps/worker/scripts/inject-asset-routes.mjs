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
 * - Cloudflare 上限 100 条，这里最多用到 MAX_RULES 条。放不下时按收益排序部分注入：体积大的文件优先，
 *   同体积按文件名排序；其余文件仍经 Worker（行为正确，只是绕路），打印 warning。
 * - 文件名含 glob 元字符或引号等非常规字符时跳过该文件（仍经 Worker，行为安全）。
 *
 * 用法：
 *   node scripts/inject-asset-routes.mjs [--config wrangler.toml] [--assets dist/assets]
 *     部署时改写 wrangler.toml。
 *   node scripts/inject-asset-routes.mjs --check [--config wrangler.toml] [--assets dist/assets]
 *     构建后的预算检查，只读不写：所需条数达到 WARN_RULES 时 warning，超过 MAX_RULES 时 error 并以 1 退出，
 *     让 PR 的构建在部署被迫部分注入之前失败。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_RULES = 95;
export const WARN_RULES = 85;
const SAFE_NAME = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const ARRAY_PATTERN = /^(run_worker_first\s*=\s*)\[([^\]]*)\]/m;

/** 递归列出目录下的文件：相对路径（以 / 分隔）与字节数 */
export function listAssetFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push({ file: relative(dir, full).split(sep).join('/'), size: stat.size });
    }
  };
  walk(dir);
  return out;
}

/**
 * 纯函数：返回新的 toml 文本与统计；不改动 run_worker_first 以外的内容。
 * required 是全部排除所需的总条数（预算检查用），total 是实际写入的条数。
 */
export function injectAssetRoutes(toml, files, max = MAX_RULES) {
  const match = ARRAY_PATTERN.exec(toml);
  if (!match) throw new Error('wrangler.toml 中找不到 run_worker_first 数组');
  const entries = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const base = entries.filter((entry) => !entry.startsWith('!/assets/'));
  const sizes = new Map();
  for (const { file, size } of files) if (SAFE_NAME.test(file)) sizes.set(file, size);
  const candidates = [...sizes.keys()];
  const skipped = files.length - candidates.length;
  const capacity = Math.max(0, max - base.length);
  const chosen = new Set(
    [...candidates]
      .sort((a, b) => sizes.get(b) - sizes.get(a) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, capacity),
  );
  // 输出顺序跟随文件列表，与是否部分注入无关，重复执行结果稳定
  const exclusions = candidates.filter((file) => chosen.has(file)).map((file) => `!/assets/${file}`);
  const next = [...base, ...exclusions];
  const rendered = `${match[1]}[${next.map((entry) => JSON.stringify(entry)).join(', ')}]`;
  return {
    toml: toml.slice(0, match.index) + rendered + toml.slice(match.index + match[0].length),
    base: base.length,
    required: base.length + candidates.length,
    total: next.length,
    injected: exclusions.length,
    omitted: candidates.length - exclusions.length,
    skipped,
  };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const check = args.includes('--check');
  const configPath = option('--config', join(root, 'wrangler.toml'));
  const assetsDir = option('--assets', join(root, 'dist', 'assets'));
  let files = [];
  try {
    files = listAssetFiles(assetsDir);
  } catch (error) {
    if (check) {
      console.error(`::error::读取 ${assetsDir} 失败（${error.message}），无法核对静态资源排除规则预算`);
      process.exit(1);
    }
    console.error(`::warning::读取 ${assetsDir} 失败（${error.message}），不注入静态资源排除规则`);
  }
  const result = injectAssetRoutes(readFileSync(configPath, 'utf8'), files);
  if (result.skipped) console.error(`::warning::${result.skipped} 个文件名含非常规字符，保持经 Worker`);

  if (check) {
    const summary = `run_worker_first 需要 ${result.required} 条（原有规则 ${result.base} 条 + 静态资源 ${result.required - result.base} 个），预警线 ${WARN_RULES}，上限 ${MAX_RULES}`;
    if (result.required > MAX_RULES) {
      console.error(`::error::${summary}。超出部分部署时只能经 Worker 绕到 placement 区域，先合并小 chunk 或改为目录级排除`);
      process.exit(1);
    }
    if (result.required >= WARN_RULES) console.error(`::warning::${summary}，余量只剩 ${MAX_RULES - result.required} 条`);
    console.log(summary);
    return;
  }

  writeFileSync(configPath, result.toml);
  if (result.omitted) {
    console.error(`::warning::静态资源 ${result.required - result.base} 个，加上原有规则超过 ${MAX_RULES} 条上限，只排除体积最大的 ${result.injected} 个，其余 ${result.omitted} 个仍经 Worker`);
  }
  console.log(`run_worker_first 共 ${result.total} 条，其中静态资源排除 ${result.injected} 条`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
