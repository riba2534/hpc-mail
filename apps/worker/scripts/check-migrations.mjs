#!/usr/bin/env node
/**
 * 迁移规约检查（随 `pnpm --filter @hpc-mail/worker test` 前置执行）。
 *
 * 部署顺序是先 `d1 migrations apply`、再发布 Worker，迁移落地到新代码生效之间，线上跑的仍是旧代码；
 * 部署失败自动回滚时也只回滚 Worker、不回滚迁移。所以迁移必须对旧代码保持兼容，只做加法：
 * - 不许 DROP TABLE、ALTER TABLE … DROP COLUMN / RENAME COLUMN / RENAME TO：旧代码仍在读写这些表和列。
 * - 不许整表重建（drizzle 改列时生成 `__new_<表>` + 拷全表 + DROP 原表）：热表重建会撞 D1 执行时限，期间旧代码读写失败。
 * - 不许 DROP 仍被 src 里 `INDEXED BY` 引用的索引：索引不存在时整条语句直接报错，
 *   D1 规划器没有 STAT4，这些查询靠 INDEXED BY 选索引（见 CLAUDE.md）。
 *   先发一版去掉引用，下一版再删索引；改索引定义请换新名字（索引只增不改名）。
 * 另外校验 INDEXED BY 引用的索引在迁移重放后确实存在（这一项不能豁免）。
 *
 * LEGACY_MIGRATIONS 列出的迁移已在线上执行，只参与索引重放、不再检查语句；按完整文件名精确匹配，
 * 其他任何文件（新编号、0005b_x.sql、不带编号的 x.sql）都要检查。
 * 确需破坏性变更时在迁移文件里写 `-- migration-check: allow <原因>` 豁免整个文件，检查输出会列出全部豁免。
 * SQL 按词法切分：字符串字面量、`--` 与 `/* *\/` 注释、"x" / `x` / [x] 引用标识符与 schema.x 限定名都按 SQLite 规则处理。
 *
 * 用法：node scripts/check-migrations.mjs [--migrations <目录>] [--src <目录>]（默认本包的 migrations 与 src）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 引入本检查前已上线的 0000–0020，只增不改：新迁移不要加进来，确需例外用 allow 标注 */
const LEGACY_MIGRATIONS = new Set([
  '0000_moaning_maelstrom.sql',
  '0001_legal_stellaris.sql',
  '0002_elite_hobgoblin.sql',
  '0003_old_tiger_shark.sql',
  '0004_tiresome_doctor_doom.sql',
  '0005_acoustic_meteorite.sql',
  '0006_funny_mikhail_rasputin.sql',
  '0007_nebulous_maginty.sql',
  '0008_complete_shape.sql',
  '0009_redundant_namor.sql',
  '0010_tough_the_hand.sql',
  '0011_fancy_vargas.sql',
  '0012_smart_prima.sql',
  '0013_mail_functional_reliability.sql',
  '0014_perf_indexes.sql',
  '0015_verification_link.sql',
  '0016_message_translations.sql',
  '0017_user_mailbox_policy.sql',
  '0018_active_admin_index.sql',
  '0019_claude_address_facts.sql',
  '0020_hosted_domains.sql',
]);

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

/**
 * SQLite 词法切分：返回 { type: 'word' | 'ident' | 'punct', value } 序列，丢弃空白、注释与字符串内容。
 * word 是未加引号的关键字或名字（原样保留大小写），ident 是加了引号的名字；名字比较时都转小写。
 */
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  // 引号内连写两个闭合符（'it''s'）是转义；按「闭合后紧接着又开一个」切分得到的边界相同，不必特殊处理
  const until = (close, from) => {
    const k = sql.indexOf(close, from);
    return k === -1 ? [sql.slice(from), sql.length] : [sql.slice(from, k), k + 1];
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') { const end = sql.indexOf('\n', i); i = end === -1 ? sql.length : end + 1; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; continue; }
    if (ch === "'") { [, i] = until("'", i + 1); tokens.push({ type: 'string', value: '' }); continue; }
    if (ch === '"' || ch === '`' || ch === '[') {
      const [value, next] = until(ch === '[' ? ']' : ch, i + 1);
      tokens.push({ type: 'ident', value });
      i = next;
      continue;
    }
    const word = /^[A-Za-z0-9_$]+/.exec(sql.slice(i, i + 256));
    if (word) { tokens.push({ type: 'word', value: word[0] }); i += word[0].length; continue; }
    tokens.push({ type: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

/** 按分号切语句 */
function statements(tokens) {
  const out = [[]];
  for (const token of tokens) {
    if (token.type === 'punct' && token.value === ';') out.push([]);
    else out.at(-1).push(token);
  }
  return out.filter((s) => s.length);
}

const isName = (t) => t && (t.type === 'word' || t.type === 'ident');
const kw = (t, ...words) => t?.type === 'word' && words.includes(t.value.toUpperCase());

/** 从 at 起读一个可能带 schema 限定的名字（main.x、"main"."x"），返回 [小写名字, 下一位置] */
function qualifiedName(tokens, at) {
  let i = at;
  if (!isName(tokens[i])) return [null, i];
  let name = tokens[i].value;
  while (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '.' && isName(tokens[i + 2])) {
    name = tokens[i + 2].value;
    i += 2;
  }
  return [name.toLowerCase(), i + 1];
}

/** 跳过 IF [NOT] EXISTS */
function skipIfExists(tokens, at) {
  let i = at;
  if (kw(tokens[i], 'IF')) {
    i += 1;
    if (kw(tokens[i], 'NOT')) i += 1;
    if (kw(tokens[i], 'EXISTS')) i += 1;
  }
  return i;
}

/** 解析一条语句：索引增删，以及破坏旧代码兼容性的变更说明 */
function analyze(tokens) {
  const breaking = [];
  let index = null;
  const renamedNew = tokens.find((t) => isName(t) && t.value.toLowerCase().startsWith('__new_'));
  if (renamedNew) breaking.push(`整表重建（${renamedNew.value}）`);
  if (kw(tokens[0], 'CREATE')) {
    let i = 1;
    if (kw(tokens[i], 'UNIQUE')) i += 1;
    if (kw(tokens[i], 'INDEX')) index = { op: 'create', name: qualifiedName(tokens, skipIfExists(tokens, i + 1))[0] };
  } else if (kw(tokens[0], 'DROP')) {
    if (kw(tokens[1], 'INDEX')) index = { op: 'drop', name: qualifiedName(tokens, skipIfExists(tokens, 2))[0] };
    else if (kw(tokens[1], 'TABLE')) breaking.push(`DROP TABLE ${qualifiedName(tokens, skipIfExists(tokens, 2))[0]}`);
  } else if (kw(tokens[0], 'ALTER') && kw(tokens[1], 'TABLE')) {
    const [table, i] = qualifiedName(tokens, 2);
    if (kw(tokens[i], 'DROP')) breaking.push(`ALTER TABLE ${table} DROP COLUMN`);
    else if (kw(tokens[i], 'RENAME')) breaking.push(kw(tokens[i + 1], 'TO') ? `ALTER TABLE ${table} RENAME TO` : `ALTER TABLE ${table} RENAME COLUMN`);
  }
  return { index, breaking };
}

// INDEXED BY 引用：字面量名字；`INDEXED BY ${expr}` 动态拼接时取同文件里所有带引号的 idx_ 字符串
const referenced = new Map();
for (const file of walk(srcDir).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  const names = [...text.matchAll(/INDEXED BY\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  if (/INDEXED BY\s+\$\{/.test(text)) names.push(...[...text.matchAll(/['"`](idx_[A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]));
  for (const name of names) referenced.set(name.toLowerCase(), relative(dirname(srcDir), file));
}

const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const violations = [];
const allowed = [];
const indexes = new Set();
for (const file of migrations) {
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const checked = !LEGACY_MIGRATIONS.has(file);
  const allow = /^\s*--\s*migration-check:\s*allow\s+(\S.*)$/m.exec(sql);
  const found = [];
  for (const statement of statements(tokenize(sql))) {
    const { index, breaking } = analyze(statement);
    found.push(...breaking);
    if (index?.op === 'create') indexes.add(index.name);
    if (index?.op === 'drop') {
      indexes.delete(index.name);
      if (referenced.has(index.name)) {
        found.push(`DROP INDEX ${index.name}，但 ${referenced.get(index.name)} 仍用 INDEXED BY 引用它`);
      }
    }
  }
  if (!checked || !found.length) continue;
  if (allow) allowed.push(`${file}（${allow[1].trim()}）：${found.join('；')}`);
  else violations.push(...found.map((f) => `${file}：${f}`));
}
for (const [name, file] of referenced) {
  if (!indexes.has(name)) violations.push(`${file}：INDEXED BY ${name}，但迁移重放后不存在该索引`);
}

if (allowed.length) console.log(`迁移规约豁免（${allowed.length} 个文件，-- migration-check: allow）：\n- ${allowed.join('\n- ')}`);
if (violations.length) {
  console.error(
    `迁移规约检查失败（${violations.length} 项）：\n- ${violations.join('\n- ')}\n` +
      '迁移先于代码上线、回滚也不回滚迁移，旧代码必须能在新 schema 上运行：只加表、加列、加索引；' +
      '删除或改名请分两次发布（先发不再使用的代码），确需例外时在文件里写 -- migration-check: allow <原因>。',
  );
  process.exit(1);
}
console.log(`迁移规约检查通过（${migrations.length} 个迁移，${referenced.size} 个 INDEXED BY 索引）`);
