CREATE TABLE `external_attachment_links` (
	`attachment_id` integer PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_external_links_expiry` ON `external_attachment_links` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_external_links_r2` ON `external_attachment_links` (`r2_key`);--> statement-breakpoint
CREATE TABLE `notification_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer,
	`user_id` integer NOT NULL,
	`channel` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer NOT NULL,
	`last_attempt_at` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`last_http_status` integer,
	`dedupe_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_jobs_dedupe_key_unique` ON `notification_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_due` ON `notification_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_user` ON `notification_jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `storage_cleanup_jobs` (
	`r2_key` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `idempotency_records` ADD `message_id` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `recipient_outcomes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `purge_token` text;--> statement-breakpoint
CREATE INDEX `idx_attachments_r2_key` ON `attachments` (`r2_key`);
--> statement-breakpoint
-- Preserve existing outbound attachment links for the originally promised lifetime.
INSERT OR IGNORE INTO external_attachment_links (attachment_id, r2_key, filename, mime_type, size, expires_at)
SELECT a.id, a.r2_key, a.filename, a.mime_type, a.size, m.created_at + 7776000000
FROM attachments a JOIN messages m ON m.id = a.message_id
WHERE m.direction = 'outbound' AND m.created_at + 7776000000 > unixepoch() * 1000;
--> statement-breakpoint
DELETE FROM attachments WHERE id NOT IN (SELECT MIN(id) FROM attachments GROUP BY message_id, r2_key);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_message_object` ON `attachments` (`message_id`,`r2_key`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `notify_owner_ids` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `notifications_queued_at` integer;
--> statement-breakpoint
CREATE TABLE `delivery_object_leases` (
	`r2_key` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`r2_key`, `token`)
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_lease_expiry` ON `delivery_object_leases` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_messages_notification_outbox` ON `messages` (`created_at`,`id`) WHERE "messages"."notify_owner_ids" IS NOT NULL AND "messages"."notifications_queued_at" IS NULL AND "messages"."deleted_at" IS NULL;
