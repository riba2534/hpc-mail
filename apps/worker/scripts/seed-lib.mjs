// seed-admin.mjs 与 seed-smoke.mjs 共用：密码哈希与 D1 执行。
// 哈希格式与 worker src/lib/password.ts 完全一致：pbkdf2-sha256$100000$<salt>$<hash>（base64url）
// D1 目标：CI 默认 --remote；本地传 --local [--persist-to <目录>]
import { execFileSync } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 100000;

/** 系统保留用户名，须与 packages/shared/src/constants.ts 的 RESERVED_USERNAMES 一致；ci-smoke 是部署冒烟专用账号 */
export const RESERVED_USERNAMES = ['ci-smoke'];

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 32 * 8);
  return Buffer.from(bits);
}

/** 生成的哈希只含数字、`$` 与 base64url 字符，可以直接拼进 SQL 字符串 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${Buffer.from(salt).toString('base64url')}$${(await pbkdf2(password, salt)).toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [version, iterations, salt, hash] = String(stored).split('$');
  if (version !== 'pbkdf2-sha256' || iterations !== String(ITERATIONS) || !salt || !hash) return false;
  return (await pbkdf2(password, Buffer.from(salt, 'base64url'))).equals(Buffer.from(hash, 'base64url'));
}

const argv = process.argv.slice(2);
const target = argv.includes('--local') ? ['--local'] : ['--remote'];
const persistAt = argv.indexOf('--persist-to');
if (persistAt !== -1) target.push('--persist-to', argv[persistAt + 1]);

/**
 * 执行一条 SQL 并返回结果行。wrangler d1 execute 没有绑定参数，调用方只能拼本脚本生成或校验过格式的值。
 * 'db' 是 wrangler.toml 里的 D1 binding 名——按 binding 解析对一键部署（资源名可能不同）与 CI 都成立
 */
export function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'db', ...target, '--json', '--command', sql],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return JSON.parse(out)[0]?.results ?? [];
}
