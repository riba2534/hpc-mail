#!/usr/bin/env node
/**
 * 迁移规约检查（随 `pnpm --filter @hpc-mail/worker test` 前置执行）。
 *
 * 部署顺序是先 `d1 migrations apply`、再发布 Worker，迁移落地到新代码生效之间，线上跑的仍是旧代码；
 * 部署失败自动回滚时也只回滚 Worker、不回滚迁移。所以迁移必须对旧代码保持兼容：
 * 1. 不许整表重建 messages（drizzle 改列时生成 `__new_messages` + 拷全表 + DROP 原表）：
 *    热表行多、正文大，重建会撞 D1 的执行时限与单库写入上限，期间旧代码读写也会失败。
 * 2. 不许 DROP 仍被 src 里 `INDEXED BY` 引用的索引：索引不存在时整条语句直接报错，
 *    D1 规划器没有 STAT4，这些查询靠 INDEXED BY 选索引（见 CLAUDE.md）。
 *    先发一版去掉引用，下一版再删索引；改索引定义请换新名字（索引只增不改名）。
 * 另外校验 INDEXED BY 引用的索引在迁移重放后确实存在。
 *
 * 用法：node scripts/check-migrations.mjs [--migrations <目录>] [--src <目录>]（默认本包的 migrations 与 src）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const migrationsDir = arg('--migrations', join(root, 'migrations'));
const srcDir = arg('--src', join(root, 'src'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const NAME = '`?"?([A-Za-z_][A-Za-z0-9_]*)"?`?';
// 先剥掉 SQL 注释，避免注释里的语句片段被当成真实变更
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// INDEXED BY 引用：字面量名字；`INDEXED BY ${expr}` 动态拼接时取同文件里所有带引号的 idx_ 字符串
const referenced = new Map();
for (const file of walk(srcDir).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  const names = [...text.matchAll(/INDEXED BY\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  if (/INDEXED BY\s+\$\{/.test(text)) names.push(...[...text.matchAll(/['"`](idx_[A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]));
  for (const name of names) referenced.set(name, relative(dirname(srcDir), file));
}

const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const violations = [];
const indexes = new Set();
const drops = [];
for (const [order, file] of migrations.entries()) {
  const sql = stripComments(readFileSync(join(migrationsDir, file), 'utf8'));
  if (/__new_messages\b/.test(sql)) {
    violations.push(`${file}：整表重建 messages（__new_messages）。改用 ALTER TABLE ADD COLUMN 等加法变更，或拆成新表`);
  }
  // 按语句顺序重放索引的增删
  for (const m of sql.matchAll(new RegExp(`\\b(CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?|DROP\\s+INDEX(?:\\s+IF\\s+EXISTS)?)\\s+${NAME}`, 'gi'))) {
    const name = m[2];
    if (/^CREATE/i.test(m[1])) indexes.add(name);
    else {
      indexes.delete(name);
      drops.push({ order, file, name });
    }
  }
}
for (const { order, file, name } of drops) {
  if (!referenced.has(name)) continue;
  // 之后的迁移重新建了同名索引，说明这是历史上的删除、当前引用的是新建的那一个
  const recreated = migrations.slice(order + 1).some((later) =>
    new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+\`?"?${name}"?\`?\\s`, 'i')
      .test(stripComments(readFileSync(join(migrationsDir, later), 'utf8'))));
  if (!recreated) {
    violations.push(`${file}：DROP INDEX ${name}，但 ${referenced.get(name)} 仍用 INDEXED BY 引用它（迁移先于代码上线，旧代码会直接报错）`);
  }
}
for (const [name, file] of referenced) {
  if (!indexes.has(name)) violations.push(`${file}：INDEXED BY ${name}，但迁移重放后不存在该索引`);
}

if (violations.length) {
  console.error(`迁移规约检查失败（${violations.length} 项）：\n- ${violations.join('\n- ')}`);
  process.exit(1);
}
console.log(`迁移规约检查通过（${migrations.length} 个迁移，${referenced.size} 个 INDEXED BY 索引）`);
