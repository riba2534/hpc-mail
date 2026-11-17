CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`send_at` integer,
	`created_via` text NOT NULL,
	`api_key_id` integer,
	`scheduled_by_key_id` integer,
	`scheduled_auth_version` integer,
	`origin` text DEFAULT '' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`claimed_at` integer,
	`message_id` integer,
	`error_detail` text DEFAULT '' NOT NULL,
	`idempotency_key` text,
	`request_hash` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_drafts_user` ON `drafts` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_drafts_due` ON `drafts` (`send_at`) WHERE "drafts"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX `idx_drafts_sending` ON `drafts` (`claimed_at`) WHERE "drafts"."status" = 'sending';--> statement-breakpoint
CREATE INDEX `idx_drafts_sent` ON `drafts` (`sent_at`) WHERE "drafts"."status" = 'sent';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_drafts_idempotency` ON `drafts` (`idempotency_key`) WHERE "drafts"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `draft_attachments` ADD `draft_id` integer;--> statement-breakpoint
CREATE INDEX `idx_draft_attachments_draft` ON `draft_attachments` (`draft_id`) WHERE "draft_attachments"."draft_id" IS NOT NULL;
