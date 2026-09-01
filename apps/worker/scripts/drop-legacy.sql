-- 一次性清空线上 D1（仅 workflow_dispatch reset_database=true 时执行）
-- 旧系统（cloud-mail 下游）全部表
DROP TABLE IF EXISTS api_rate_limit;
DROP TABLE IF EXISTS api_call_log;
DROP TABLE IF EXISTS api_key;
DROP TABLE IF EXISTS api_config;
DROP TABLE IF EXISTS role_perm;
DROP TABLE IF EXISTS star;
DROP TABLE IF EXISTS email;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS reg_key;
DROP TABLE IF EXISTS verify_record;
DROP TABLE IF EXISTS user;
DROP TABLE IF EXISTS perm;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS setting;
DROP TABLE IF EXISTS schema_meta;
-- 新系统表（幂等重跑保护）
DROP TABLE IF EXISTS api_rate_limits;
DROP TABLE IF EXISTS api_request_logs;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS draft_attachments;
DROP TABLE IF EXISTS admin_audit_logs;
DROP TABLE IF EXISTS rate_counters;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS stars;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS mailboxes;
DROP TABLE IF EXISTS users;
-- 迁移 journal（清掉后 migrations apply 会从 0 重放）
DROP TABLE IF EXISTS d1_migrations;
