#!/usr/bin/env node
/**
 * inject-asset-routes.mjs 自检：临时目录造 wrangler.toml 与 dist/assets，按 CI 的方式执行脚本，
 * 校验注入结果、幂等、超限回退与非常规文件名跳过。随 `pnpm --filter @hpc-mail/worker test` 前置执行。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'inject-asset-routes.mjs');
const original = [
  'name = "fixture"',
  '',
  '[assets]',
  'directory = "./dist"',
  'run_worker_first = ["/api", "/api/*", "/v1", "/v1/*", "/skill.md", "/references/*", "/llms.txt", "/assets/*"]',
  '',
  '[vars]',
  'site_origin = "https://example.test"',
  '',
].join('\n');

const work = mkdtempSync(join(tmpdir(), 'hpc-inject-assets-'));
try {
  const config = join(work, 'wrangler.toml');
  const assets = join(work, 'dist', 'assets');
  const run = () => execFileSync(process.execPath, [script, '--config', config, '--assets', assets], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const routes = () => {
    const line = readFileSync(config, 'utf8').split('\n').find((l) => l.startsWith('run_worker_first'));
    return JSON.parse(line.slice(line.indexOf('[')));
  };

  // 1. 正常注入：保留全部原有规则（含 /assets/*），为每个现存文件追加排除；其余配置原样保留
  writeFileSync(config, original);
  mkdirSync(join(assets, 'nested'), { recursive: true });
  for (const file of ['index-AbC123xy.js', 'index-Zz9_-8wq.css', 'logo-1a2b3c4d.webp']) writeFileSync(join(assets, file), 'x');
  writeFileSync(join(assets, 'nested', 'font-12345678.woff2'), 'x');
  run();
  const first = routes();
  assert.deepEqual(first.slice(0, 8), ['/api', '/api/*', '/v1', '/v1/*', '/skill.md', '/references/*', '/llms.txt', '/assets/*']);
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
  run();
  assert.ok(!routes().some((r) => r.includes('weird')));

  // 5. 超过上限不注入，回退为原有规则
  for (let i = 0; i < 100; i++) writeFileSync(join(assets, `chunk-${String(i).padStart(8, '0')}.js`), 'x');
  const out = run();
  assert.deepEqual(routes(), ['/api', '/api/*', '/v1', '/v1/*', '/skill.md', '/references/*', '/llms.txt', '/assets/*']);
  assert.match(out, /其中静态资源排除 0 条/);

  // 6. 资源目录不存在：不注入、不报错
  rmSync(join(work, 'dist'), { recursive: true, force: true });
  writeFileSync(config, original);
  run();
  assert.deepEqual(routes(), ['/api', '/api/*', '/v1', '/v1/*', '/skill.md', '/references/*', '/llms.txt', '/assets/*']);

  console.log('inject-asset-routes 自检通过');
} finally {
  rmSync(work, { recursive: true, force: true });
}
