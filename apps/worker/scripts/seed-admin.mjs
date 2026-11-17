#!/usr/bin/env node
// 幂等 admin 引导：库内无 admin 时插入（CI 部署前执行；本地传 --local [--persist-to <目录>]）
import { d1, hashPassword } from './seed-lib.mjs';

const username = (process.env.ADMIN_USERNAME ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
// --if-env：一键部署等无凭据场景下静默跳过（可稍后手动执行本脚本引导管理员）
if (process.argv.includes('--if-env') && (!username || !password)) {
  console.log('未提供 ADMIN_USERNAME/ADMIN_PASSWORD，跳过管理员引导；稍后可手动执行本脚本创建管理员');
  process.exit(0);
}
if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) {
  console.error('ADMIN_USERNAME 非法（3-32 位小写字母/数字/-_）');
  process.exit(1);
}
if (password.length < 12 || password.length > 128) {
  console.error('ADMIN_PASSWORD 需 12-128 位');
  process.exit(1);
}

d1(`INSERT INTO users (username, password_hash, role, status)
SELECT '${username}', '${await hashPassword(password)}', 'admin', 'active'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');`);
console.log('admin 引导完成（已存在则跳过）');
