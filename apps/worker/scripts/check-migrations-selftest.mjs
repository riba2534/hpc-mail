#!/usr/bin/env node
/**
 * check-migrations.mjs 自检：临时目录造 migrations 与 src，按 CI 的方式执行脚本。
 * 覆盖：破坏旧代码兼容性的各类语句、删除仍被 INDEXED BY 引用的索引及其各种写法（限定名、三种引号、
 * 字符串与注释里的 -- 和 /* 干扰）、引用不存在的索引、历史迁移不检查、文件级豁免会被列出。
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

// 历史迁移按完整文件名白名单豁免语句检查（只参与索引重放）；夹具用真实的历史文件名做基线
const BASE = [
  'CREATE TABLE `messages` (`id` integer PRIMARY KEY, `address` text, `deleted_at` integer);',
  'CREATE INDEX `idx_messages_address` ON `messages` (`address`,`deleted_at`,`id`);--> statement-breakpoint',
  'CREATE INDEX `idx_messages_old` ON `messages` (`deleted_at`);',
].join('\n');
const SRC = { 'services/message.ts': 'export const q = sql`SELECT id FROM messages INDEXED BY idx_messages_address WHERE address = ?`;\n' };

function run(migrations, sources = SRC) {
  const dir = mkdtempSync(join(work, 'case-'));
  mkdirSync(join(dir, 'migrations'));
  mkdirSync(join(dir, 'src', 'services'), { recursive: true });
  for (const [name, sql] of Object.entries({ '0000_moaning_maelstrom.sql': BASE, ...migrations })) writeFileSync(join(dir, 'migrations', name), sql);
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, 'src', name), text);
  const result = spawnSync(process.execPath, [script, '--migrations', join(dir, 'migrations'), '--src', join(dir, 'src')], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}
const passes = (migrations, sources) => {
  const r = run(migrations, sources);
  assert.equal(r.status, 0, r.output);
  return r.output;
};
const fails = (migrations, pattern, sources) => {
  const r = run(migrations, sources);
  assert.equal(r.status, 1, `应失败：${JSON.stringify(migrations)}\n${r.output}`);
  assert.match(r.output, pattern);
  return r.output;
};
const DROPPED = /0021_x\.sql：DROP INDEX idx_messages_address，但 src\/services\/message\.ts 仍用 INDEXED BY 引用它/;

try {
  // 合规：加列、加索引、删除未被引用的索引；字符串和注释里的危险字样不算
  passes({
    '0021_x.sql': [
      'ALTER TABLE `messages` ADD `flag` integer DEFAULT 0;--> statement-breakpoint',
      'CREATE INDEX IF NOT EXISTS `idx_messages_flag` ON `messages` (`flag`);',
      "INSERT INTO settings (key, value) VALUES ('note', 'DROP TABLE messages; DROP INDEX idx_messages_address');",
      '-- DROP TABLE messages',
      '/* ALTER TABLE messages DROP COLUMN address */',
      'DROP INDEX `idx_messages_old`;',
    ].join('\n'),
  });

  // 破坏旧代码兼容性的语句
  fails({ '0021_x.sql': 'DROP TABLE IF EXISTS `stars`;' }, /0021_x\.sql：DROP TABLE stars/);
  fails({ '0021_x.sql': 'ALTER TABLE `messages` DROP COLUMN `address`;' }, /ALTER TABLE messages DROP COLUMN/);
  fails({ '0021_x.sql': 'ALTER TABLE messages DROP address;' }, /ALTER TABLE messages DROP COLUMN/);
  fails({ '0021_x.sql': 'ALTER TABLE "messages" RENAME COLUMN "address" TO "addr";' }, /ALTER TABLE messages RENAME COLUMN/);
  fails({ '0021_x.sql': 'ALTER TABLE main.messages RENAME TO messages_old;' }, /ALTER TABLE messages RENAME TO/);
  fails({
    '0021_x.sql': 'CREATE TABLE `__new_users` (`id` integer PRIMARY KEY);--> statement-breakpoint\nINSERT INTO `__new_users`("id") SELECT "id" FROM `users`;',
  }, /0021_x\.sql：整表重建（__new_users）/);
  fails({ '0021_x.sql': 'CREATE TABLE [__NEW_messages] (id integer);' }, /整表重建（__NEW_messages）/);

  // 删除仍被引用的索引：各种名字写法都要识别
  for (const sql of [
    'DROP INDEX `idx_messages_address`;',
    'DROP INDEX IF EXISTS "idx_messages_address";',
    'drop index [idx_messages_address];',
    'DROP INDEX main.idx_messages_address;',
    'DROP INDEX "main"."IDX_MESSAGES_ADDRESS";',
    'DROP\nINDEX\n  idx_messages_address;',
    // 字符串里的 -- 不是注释，同一行后面的语句照样生效
    "INSERT INTO settings (key, value) VALUES ('--', 'x'); DROP INDEX idx_messages_address;",
    // 块注释里的 -- 不会吞掉注释结束后的语句
    '/* -- */ DROP INDEX idx_messages_address;',
    // 字符串里的 /* 也不是注释开头
    "SELECT '/*'; DROP INDEX idx_messages_address; SELECT '*/';",
    // 字符串里转义的单引号不会让字符串提前结束
    "SELECT 'it''s -- fine'; DROP INDEX idx_messages_address;",
  ]) {
    fails({ '0021_x.sql': sql }, DROPPED);
  }

  // 同一迁移里删了再建同名索引也拦：索引只增不改名
  fails({ '0021_x.sql': 'DROP INDEX `idx_messages_address`;\nCREATE INDEX `idx_messages_address` ON `messages` (`address`);' }, DROPPED);

  // 动态拼接 INDEXED BY ${index}：同文件里带引号的 idx_ 名字都算引用；删除后也不存在了
  let out = fails({ '0021_x.sql': 'DROP INDEX IF EXISTS "idx_messages_old";' }, /DROP INDEX idx_messages_old，但 src\/services\/facts\.ts 仍用 INDEXED BY 引用它/, {
    'services/facts.ts': "export const harvest = (index: 'idx_messages_old' | 'idx_messages_address') => `SELECT 1 FROM messages INDEXED BY ${index}`;\n",
  });
  assert.match(out, /INDEXED BY idx_messages_old，但迁移重放后不存在该索引/);

  // 引用从未建过的索引（不可豁免）
  fails({ '0021_x.sql': '-- migration-check: allow 测试\nSELECT 1;' }, /INDEXED BY idx_messages_missing，但迁移重放后不存在该索引/, {
    'services/message.ts': 'const q = sql`SELECT 1 FROM messages INDEXED BY idx_messages_missing`;\n',
  });

  // 白名单里的历史迁移只重放索引，不检查语句
  passes({ '0005_acoustic_meteorite.sql': 'ALTER TABLE messages DROP COLUMN legacy;\nDROP TABLE old_stuff;' });
  // 但历史上删掉的索引不能再被引用
  fails({ '0005_acoustic_meteorite.sql': 'DROP INDEX idx_messages_address;' }, /INDEXED BY idx_messages_address，但迁移重放后不存在该索引/);
  // 白名单按完整文件名匹配：编号相同或更小但名字不同、不带编号的文件都要检查
  for (const name of ['0005b_x.sql', '0005_acoustic_meteorite_v2.sql', '0000_x.sql', 'x.sql', '20_late.sql']) {
    fails({ [name]: 'DROP TABLE `stars`;' }, new RegExp(`${name.replace('.', '\\.')}：DROP TABLE stars`));
  }

  // 文件级豁免：通过，但输出里列出豁免的文件、原因与语句
  out = passes({ '0022_cleanup.sql': '-- migration-check: allow stars 表已两个版本无人读写\nDROP TABLE `stars`;' });
  assert.match(out, /迁移规约豁免（1 个文件[^\n]*\n- 0022_cleanup\.sql（stars 表已两个版本无人读写）：DROP TABLE stars/);
  // 豁免只对写了标注的文件生效
  fails({ '0022_cleanup.sql': '-- migration-check: allow 清理\nDROP TABLE `stars`;', '0023_more.sql': 'DROP TABLE `users`;' }, /0023_more\.sql：DROP TABLE users/);

  console.log('check-migrations 自检通过');
} finally {
  rmSync(work, { recursive: true, force: true });
}
