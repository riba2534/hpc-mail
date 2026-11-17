-- 入站邮件的发件认证结果（Cloudflare Email Routing 的 Authentication-Results 解析值，JSON：spf/dkim/dkimDomain/dmarc/aligned）。
-- NULL 表示没有可信结果：本迁移之前的历史邮件、站内互投、发件。只加列，不回填。
ALTER TABLE `messages` ADD `auth` text;
