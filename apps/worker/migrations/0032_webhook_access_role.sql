-- 端点可见的邮件范围按创建/修改它的凭据的有效角色计算（不按 users.role）：实际角色取 min(access_role, users.role)。
-- 默认 admin：现有行与旧代码写入的行行为不变；没有 admin scope 的管理员 Key 写入的端点存 user，只收自己认领地址的来信
ALTER TABLE `webhook_endpoints` ADD `access_role` text DEFAULT 'admin' NOT NULL;
