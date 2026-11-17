-- Anthropic 收据（services/claude-receipts.ts）：由官方收据来信解析金额、币种与扣款卡尾号。
-- message_id 是原邮件 id，不加外键：邮件永久删除后收据行保留原值（接口里显示为 null），同一封邮件只记一次。
CREATE TABLE `claude_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`address` text NOT NULL,
	`domain` text NOT NULL,
	`received_at` integer NOT NULL,
	`subject` text NOT NULL,
	`amount_cents` integer,
	`currency` text,
	`card_last4` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_claude_receipts_message` ON `claude_receipts` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_claude_receipts_address` ON `claude_receipts` (`address`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_claude_receipts_domain` ON `claude_receipts` (`domain`);
