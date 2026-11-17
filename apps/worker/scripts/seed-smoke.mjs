#!/usr/bin/env node
// 幂等引导部署冒烟账号 ci-smoke（普通用户，不认领任何邮箱）：CI 部署前执行；本地传 --local [--persist-to <目录>]
// 密码由 JWT_SECRET 派生：hex(HMAC-SHA256(JWT_SECRET, "ci-smoke-password-v1")) 的前 32 位，
// CI 冒烟用同一公式算出密码登录，因此不需要再保存一份 secret；轮换 JWT_SECRET 后下次部署自动改密。
// 不存在则创建；存在且密码对不上则改密并 bump auth_version（旧会话失效）；
// 已被改成管理员或被禁用时拒绝覆盖，交给人工确认（这不是部署脚本该替管理员做的决定）。
// 哈希格式与 worker src/lib/password.ts 一致：pbkdf2-sha256$100000$<salt>$<hash>（base64url）
import { execFileSync } from 'node:child_process';
import { createHmac, webcrypto as crypto } from 'node:crypto';

const USERNAME = 'ci-smoke';
const ITERATIONS = 100000;

const jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret) {
  console.error('缺 JWT_SECRET：冒烟账号密码由它派生');
  process.exit(1);
}
const password = createHmac('sha256', jwtSecret).update('ci-smoke-password-v1').digest('hex').slice(0, 32);

const args = process.argv.slice(2);
const target = args.includes('--local') ? ['--local'] : ['--remote'];
const persistAt = args.indexOf('--persist-to');
if (persistAt !== -1) target.push('--persist-to', args[persistAt + 1]);

const toB64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (value) => new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

async function derive(salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 32 * 8);
  return new Uint8Array(bits);
}

async function matches(stored) {
  const [version, iterations, salt, hash] = String(stored).split('$');
  if (version !== 'pbkdf2-sha256' || iterations !== String(ITERATIONS) || !salt || !hash) return false;
  const actual = await derive(fromB64url(salt));
  const expected = fromB64url(hash);
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

/**
 * wrangler d1 execute 没有绑定参数，SQL 里只拼本脚本生成或从库里读出的值：
 * 每个值先按白名单格式校验（哈希只含 base64url、$ 与数字，id 为整数），再按 SQL 字符串规则转义单引号。
 */
const HASH_PATTERN = /^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;
function quote(value, pattern) {
  if (!pattern.test(value)) throw new Error(`拒绝把不合格式的值拼进 SQL：${value.slice(0, 16)}…`);
  return `'${value.replaceAll("'", "''")}'`;
}

function d1(sql) {
  const out = execFileSync(
    'npx',
    // 'db' 是 wrangler.toml 里的 D1 binding 名，与 seed-admin.mjs 一致
    ['wrangler', 'd1', 'execute', 'db', ...target, '--json', '--command', sql],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const [first] = JSON.parse(out);
  return first?.results ?? [];
}

const newHash = async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${toB64url(salt)}$${toB64url(await derive(salt))}`;
};

const name = quote(USERNAME, /^ci-smoke$/);
const [row] = d1(`SELECT id, role, status, password_hash FROM users WHERE username = ${name}`);

if (!row) {
  const hash = quote(await newHash(), HASH_PATTERN);
  // WHERE NOT EXISTS：并发的两次部署只会有一次插入成功（username 另有唯一约束兜底）
  d1(`INSERT INTO users (username, password_hash, role, status)
SELECT ${name}, ${hash}, 'user', 'active' WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ${name})`);
  console.log('冒烟账号已创建');
} else {
  if (row.role !== 'user') {
    console.error(`冒烟账号 ${USERNAME} 已存在但角色是 ${row.role}，拒绝覆盖；请确认后把它改回普通用户或删除`);
    process.exit(1);
  }
  if (row.status !== 'active') {
    console.error(`冒烟账号 ${USERNAME} 已被禁用，冒烟无法登录；请在管理后台启用它`);
    process.exit(1);
  }
  if (await matches(row.password_hash)) {
    console.log('冒烟账号已存在且密码一致，跳过');
  } else {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id)) throw new Error(`冒烟账号 id 异常：${row.id}`);
    const hash = quote(await newHash(), HASH_PATTERN);
    // 带旧哈希条件：与并发改密交错时不覆盖对方结果；auth_version + 1 让旧会话立即失效（同 changePassword）
    const oldHash = typeof row.password_hash === 'string' && HASH_PATTERN.test(row.password_hash)
      ? `password_hash = ${quote(row.password_hash, HASH_PATTERN)}`
      : '1 = 1';
    d1(`UPDATE users SET password_hash = ${hash}, auth_version = auth_version + 1, auth_version_migrated = 1
WHERE id = ${id} AND role = 'user' AND ${oldHash}`);
    console.log('冒烟账号密码已按当前 JWT_SECRET 更新');
  }
}
