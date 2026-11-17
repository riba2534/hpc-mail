#!/usr/bin/env node
// 幂等引导部署冒烟账号 ci-smoke（普通用户，不认领任何邮箱）：CI 部署前执行；本地传 --local [--persist-to <目录>]
// 密码由 JWT_SECRET 派生：hex(HMAC-SHA256(JWT_SECRET, "ci-smoke-password-v1")) 的前 32 位，
// CI 冒烟用同一公式算出密码登录，因此不需要再保存一份 secret；轮换 JWT_SECRET 后下次部署自动改密。
// 不存在则创建；存在且密码对不上则改密并 bump auth_version（旧会话失效）；
// 已有的同名账号看起来不像冒烟账号（管理员、已禁用、开了两步验证、认领了邮箱、在共享名单里）时拒绝覆盖、
// 也不改密码，交给管理员确认（这不是部署脚本该替管理员做的决定）。
import { createHmac } from 'node:crypto';
import { RESERVED_USERNAMES, d1, hashPassword, verifyPassword } from './seed-lib.mjs';

const [USERNAME] = RESERVED_USERNAMES;

const jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret) {
  console.error('缺 JWT_SECRET：冒烟账号密码由它派生');
  process.exit(1);
}
const password = createHmac('sha256', jwtSecret).update('ci-smoke-password-v1').digest('hex').slice(0, 32);

const [row] = d1(`SELECT u.role, u.status, u.password_hash, u.totp_enabled_at IS NOT NULL AS totp,
  (SELECT COUNT(*) FROM mailboxes m WHERE m.user_id = u.id) AS mailboxes,
  (SELECT COUNT(*) FROM mailbox_shares s WHERE s.user_id = u.id) AS shares
FROM users u WHERE u.username = '${USERNAME}'`);

const problems = row ? [
  row.role !== 'user' && `角色是 ${row.role}`,
  row.status !== 'active' && '已被禁用',
  row.totp && '开启了两步验证',
  row.mailboxes > 0 && `认领了 ${row.mailboxes} 个邮箱`,
  row.shares > 0 && `在 ${row.shares} 个邮箱的共享名单里`,
].filter(Boolean) : [];

if (problems.length) {
  console.error(`已存在的 ${USERNAME} 不像部署冒烟账号（${problems.join('、')}），拒绝覆盖，密码未改动。
它是系统保留用户名，只供 CI 冒烟以普通用户身份登录：请管理员确认来历后删除该账号，或改回无邮箱、无共享、未开两步验证的普通用户。`);
  process.exit(1);
}

if (!row) {
  // WHERE NOT EXISTS：与 username 唯一约束一起保证重复执行不报错
  d1(`INSERT INTO users (username, password_hash, role, status)
SELECT '${USERNAME}', '${await hashPassword(password)}', 'user', 'active' WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = '${USERNAME}')`);
  console.log('冒烟账号已创建');
} else if (await verifyPassword(password, row.password_hash)) {
  console.log('冒烟账号已存在且密码一致，跳过');
} else {
  // auth_version + 1 让旧会话立即失效（同 changePassword）
  d1(`UPDATE users SET password_hash = '${await hashPassword(password)}', auth_version = auth_version + 1, auth_version_migrated = 1
WHERE username = '${USERNAME}' AND role = 'user'`);
  console.log('冒烟账号密码已按当前 JWT_SECRET 更新');
}
