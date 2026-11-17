#!/usr/bin/env node
/**
 * check-migrations.mjs 自检：临时目录造 migrations 与 src，按 CI 的方式执行脚本，
 * 校验整表重建、删除仍被引用的索引、引用不存在的索引都会失败，合规写法与历史上的删除后重建能通过。
 * 随 `pnpm --filter @hpc-mail/worker test` 前置执行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-migrations.mjs');
const work = mkdtempSync(join(tmpdir(), 'hpc-check-migrations-'));

const BASE = [
  'CREATE TABLE `messages` (`id` integer PRIMARY KEY, `address` text, `deleted_at` integer);',
  'CREATE INDEX `idx_messages_address` ON `messages` (`address`,`deleted_at`,`id`);--> statement-breakpoint',
  'CREATE INDEX `idx_messages_old` ON `messages` (`deleted_at`);',
].join('\n');
const STATIC_REF = 'export const q = sql`SELECT id FROM messages INDEXED BY idx_messages_address WHERE address = ?`;\n';

function run(migrations, sources) {
  const dir = mkdtempSync(join(work, 'case-'));
  mkdirSync(join(dir, 'migrations'));
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, 'migrations', name), sql);
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, 'src', name), text);
  const result = spawnSync(process.execPath, [script, '--migrations', join(dir, 'migrations'), '--src', join(dir, 'src')], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

try {
  // 1. 合规：只增索引、删除未被引用的索引
  let r = run({ '0000_init.sql': BASE, '0001_drop_old.sql': 'DROP INDEX `idx_messages_old`;' }, { 'services/message.ts': STATIC_REF });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /2 个迁移，1 个 INDEXED BY 索引/);

  // 2. 整表重建 messages
  r = run({
    '0000_init.sql': BASE,
    '0001_rebuild.sql': 'CREATE TABLE `__new_messages` (`id` integer PRIMARY KEY);--> statement-breakpoint\nINSERT INTO `__new_messages`("id") SELECT "id" FROM `messages`;',
  }, { 'services/message.ts': STATIC_REF });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /0001_rebuild\.sql：整表重建 messages/);

  // 3. 删除仍被字面量 INDEXED BY 引用的索引（同一迁移里重建同名也不放过：索引只增不改名）
  r = run({
    '0000_init.sql': BASE,
    '0001_drop.sql': 'DROP INDEX `idx_messages_address`;--> statement-breakpoint\nCREATE INDEX `idx_messages_address` ON `messages` (`address`);',
  }, { 'services/message.ts': STATIC_REF });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /0001_drop\.sql：DROP INDEX idx_messages_address，但 src\/services\/message\.ts 仍用 INDEXED BY 引用它/);

  // 4. 动态拼接 INDEXED BY ${index}：同文件里带引号的 idx_ 名字都算引用
  r = run({ '0000_init.sql': BASE, '0001_drop_old.sql': 'DROP INDEX IF EXISTS "idx_messages_old";' }, {
    'services/facts.ts': "export const harvest = (index: 'idx_messages_old' | 'idx_messages_address') => `SELECT 1 FROM messages INDEXED BY ${index}`;\n",
  });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /DROP INDEX idx_messages_old，但 src\/services\/facts\.ts 仍用 INDEXED BY 引用它/);
  assert.match(r.output, /INDEXED BY idx_messages_old，但迁移重放后不存在该索引/);

  // 5. 历史上删除、之后的迁移又建了同名索引：当前引用的是新索引，通过
  r = run({
    '0000_init.sql': BASE,
    '0001_drop.sql': 'DROP INDEX `idx_messages_old`;',
    '0002_recreate.sql': 'CREATE INDEX `idx_messages_old` ON `messages` (`deleted_at`,`id`);',
  }, { 'services/message.ts': 'const q = sql`SELECT 1 FROM messages INDEXED BY idx_messages_old`;\n' });
  assert.equal(r.status, 0, r.output);

  // 6. 引用从未建过的索引；注释里的 DROP 不算变更
  r = run({ '0000_init.sql': `${BASE}\n-- DROP INDEX \`idx_messages_address\`;` }, {
    'services/message.ts': `${STATIC_REF}const q2 = sql\`SELECT 1 FROM messages INDEXED BY idx_messages_missing\`;\n`,
  });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /INDEXED BY idx_messages_missing，但迁移重放后不存在该索引/);
  assert.doesNotMatch(r.output, /DROP INDEX idx_messages_address/);

  console.log('check-migrations 自检通过（6 组用例）');
} finally {
  rmSync(work, { recursive: true, force: true });
}
