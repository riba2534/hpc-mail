#!/usr/bin/env node
/**
 * inject-asset-routes.mjs 自检：临时目录造 wrangler.toml 与 dist/assets，按 CI 的方式执行脚本，
 * 校验注入结果、幂等、超限时按体积部分注入、非常规文件名跳过，以及 --check 预算检查（预警线、
 * 超限非零退出、只读）。随 `pnpm --filter @hpc-mail/worker test` 前置执行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'inject-asset-routes.mjs');
const BASE = ['/api', '/api/*', '/v1', '/v1/*', '/skill.md', '/references/*', '/llms.txt', '/assets/*'];
const original = [
  'name = "fixture"',
  '',
  '[assets]',
  'directory = "./dist"',
  `run_worker_first = ${JSON.stringify(BASE).replaceAll('","', '", "')}`,
  '',
  '[vars]',
  'site_origin = "https://example.test"',
  '',
].join('\n');

const work = mkdtempSync(join(tmpdir(), 'hpc-inject-assets-'));
try {
  const config = join(work, 'wrangler.toml');
  const assets = join(work, 'dist', 'assets');
  const exec = (...extra) => {
    const result = spawnSync(process.execPath, [script, '--config', config, '--assets', assets, ...extra], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const run = () => {
    const result = exec();
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const routes = () => {
    const line = readFileSync(config, 'utf8').split('\n').find((l) => l.startsWith('run_worker_first'));
    return JSON.parse(line.slice(line.indexOf('[')));
  };
  const excluded = () => routes().filter((r) => r.startsWith('!')).map((r) => r.slice('!/assets/'.length));
  const resetAssets = () => {
    rmSync(join(work, 'dist'), { recursive: true, force: true });
    mkdirSync(assets, { recursive: true });
  };
  const files = (count, prefix = 'chunk', size = 1) => {
    for (let i = 0; i < count; i++) writeFileSync(join(assets, `${prefix}-${String(i).padStart(3, '0')}.js`), 'x'.repeat(size));
  };

  // 1. 正常注入：保留全部原有规则（含 /assets/*），为每个现存文件追加排除；其余配置原样保留
  writeFileSync(config, original);
  mkdirSync(join(assets, 'nested'), { recursive: true });
  for (const file of ['index-AbC123xy.js', 'index-Zz9_-8wq.css', 'logo-1a2b3c4d.webp']) writeFileSync(join(assets, file), 'x');
  writeFileSync(join(assets, 'nested', 'font-12345678.woff2'), 'x');
  run();
  const first = routes();
  assert.deepEqual(first.slice(0, 8), BASE);
  assert.deepEqual(first.slice(8).sort(), [
    '!/assets/index-AbC123xy.js', '!/assets/index-Zz9_-8wq.css', '!/assets/logo-1a2b3c4d.webp', '!/assets/nested/font-12345678.woff2',
  ]);
  assert.ok(readFileSync(config, 'utf8').includes('site_origin = "https://example.test"'));

  // 2. 幂等：重复执行不重复追加
  const afterFirst = readFileSync(config, 'utf8');
  run();
  assert.equal(readFileSync(config, 'utf8'), afterFirst);

  // 3. 文件变化后重建：已删除文件的排除规则被移除，新文件补上
  rmSync(join(assets, 'logo-1a2b3c4d.webp'));
  writeFileSync(join(assets, 'app-87654321.js'), 'x');
  run();
  const rebuilt = routes();
  assert.ok(!rebuilt.includes('!/assets/logo-1a2b3c4d.webp'));
  assert.ok(rebuilt.includes('!/assets/app-87654321.js'));
  assert.equal(rebuilt.filter((r) => r.startsWith('!')).length, 4);

  // 4. 非常规文件名（glob 元字符/空格）跳过，仍经 Worker
  writeFileSync(join(assets, 'weird name[1].js'), 'x');
  const weird = run();
  assert.ok(!routes().some((r) => r.includes('weird')));
  assert.match(weird.stderr, /::warning::1 个文件名含非常规字符/);

  // 5. 超过上限：原有规则不动，按体积从大到小注入到 95 条，同体积按文件名；其余文件经 Worker 并告警
  resetAssets();
  writeFileSync(config, original);
  for (let i = 0; i < 85; i++) writeFileSync(join(assets, `big-${String(i).padStart(3, '0')}.js`), 'x'.repeat(100 + i));
  for (const name of ['tie-c', 'tie-a', 'tie-e', 'tie-b', 'tie-d']) writeFileSync(join(assets, `${name}.js`), 'x'.repeat(10));
  const partial = run();
  const kept = routes();
  assert.equal(kept.length, 95);
  assert.deepEqual(kept.slice(0, 8), BASE);
  assert.equal(excluded().filter((file) => file.startsWith('big-')).length, 85);
  assert.deepEqual(excluded().filter((file) => file.startsWith('tie-')), ['tie-a.js', 'tie-b.js']);
  assert.match(partial.stderr, /::warning::静态资源 90 个.*只排除体积最大的 87 个，其余 3 个仍经 Worker/);
  assert.match(partial.stdout, /共 95 条，其中静态资源排除 87 条/);
  // 幂等：再跑一遍结果不变
  const partialToml = readFileSync(config, 'utf8');
  run();
  assert.equal(readFileSync(config, 'utf8'), partialToml);
  // 体积变化后按新体积重选：tie-e 变大挤掉同体积里排在后面的 tie-b
  writeFileSync(join(assets, 'tie-e.js'), 'x'.repeat(50));
  run();
  assert.deepEqual(excluded().filter((file) => file.startsWith('tie-')), ['tie-a.js', 'tie-e.js']);

  // 6. 资源目录不存在：不注入、不报错
  rmSync(join(work, 'dist'), { recursive: true, force: true });
  writeFileSync(config, original);
  run();
  assert.deepEqual(routes(), BASE);

  // 7. --check 预算检查：只读；需要条数达到预警线 85 告警，超过 95 报错并以 1 退出
  const check = (count) => {
    resetAssets();
    files(count);
    return exec('--check');
  };
  writeFileSync(config, original);
  const quiet = check(76);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /::(warning|error)::/);
  assert.match(quiet.stdout, /需要 84 条（原有规则 8 条 \+ 静态资源 76 个）/);
  const warned = check(77);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /::warning::run_worker_first 需要 85 条.*余量只剩 10 条/);
  const full = check(87);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stderr, /::warning::run_worker_first 需要 95 条/);
  assert.doesNotMatch(full.stderr, /::error::/);
  const over = check(88);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /::error::run_worker_first 需要 96 条/);
  assert.equal(readFileSync(config, 'utf8'), original, '--check 不能改写 wrangler.toml');
  // 部署注入后的配置里已有排除规则：预算按原有规则重新计算，不重复计数
  check(10);
  run();
  const injected = exec('--check');
  assert.equal(injected.status, 0, injected.stderr);
  assert.match(injected.stdout, /需要 18 条（原有规则 8 条 \+ 静态资源 10 个）/);
  // 构建后资源目录缺失说明产物不完整，--check 直接失败
  rmSync(join(work, 'dist'), { recursive: true, force: true });
  const missing = exec('--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::读取 .* 失败/);

  console.log('inject-asset-routes 自检通过');
} finally {
  rmSync(work, { recursive: true, force: true });
}
