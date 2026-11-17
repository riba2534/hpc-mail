#!/usr/bin/env node
// 幂等引导部署冒烟账号 ci-smoke（普通用户，不认领任何邮箱）：CI 部署前执行；本地传 --local [--persist-to <目录>]
// 密码由 JWT_SECRET 派生：hex(HMAC-SHA256(JWT_SECRET, "ci-smoke-password-v1")) 的前 32 位，
// CI 冒烟用同一公式算出密码登录，因此不需要再保存一份 secret；轮换 JWT_SECRET 后下次部署自动改密。
// 不存在则创建；存在且密码对不上则改密并 bump auth_version（旧会话失效）；
// 已被改成管理员或被禁用时拒绝覆盖，交给人工确认（这不是部署脚本该替管理员做的决定）。
import { createHmac } from 'node:crypto';
import { d1, hashPassword, verifyPassword } from './seed-lib.mjs';

const USERNAME = 'ci-smoke';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret) {
  console.error('缺 JWT_SECRET：冒烟账号密码由它派生');
  process.exit(1);
}
const password = createHmac('sha256', jwtSecret).update('ci-smoke-password-v1').digest('hex').slice(0, 32);

const [row] = d1(`SELECT role, status, password_hash FROM users WHERE username = '${USERNAME}'`);

if (!row) {
  // WHERE NOT EXISTS：与 username 唯一约束一起保证重复执行不报错
  d1(`INSERT INTO users (username, password_hash, role, status)
SELECT '${USERNAME}', '${await hashPassword(password)}', 'user', 'active' WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = '${USERNAME}')`);
  console.log('冒烟账号已创建');
} else if (row.role !== 'user') {
  console.error(`冒烟账号 ${USERNAME} 已存在但角色是 ${row.role}，拒绝覆盖；请确认后把它改回普通用户或删除`);
  process.exit(1);
} else if (row.status !== 'active') {
  console.error(`冒烟账号 ${USERNAME} 已被禁用，冒烟无法登录；请在管理后台启用它`);
  process.exit(1);
} else if (await verifyPassword(password, row.password_hash)) {
  console.log('冒烟账号已存在且密码一致，跳过');
} else {
  // auth_version + 1 让旧会话立即失效（同 changePassword）
  d1(`UPDATE users SET password_hash = '${await hashPassword(password)}', auth_version = auth_version + 1, auth_version_migrated = 1
WHERE username = '${USERNAME}' AND role = 'user'`);
  console.log('冒烟账号密码已按当前 JWT_SECRET 更新');
}
