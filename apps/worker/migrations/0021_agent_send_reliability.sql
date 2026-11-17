ALTER TABLE `notification_jobs` ADD `forward_mode` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_draft_r2_key` ON `draft_attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `idx_messages_outbound_pending` ON `messages` (`created_at`) WHERE "messages"."direction" = 'outbound' AND "messages"."status" = 'pending';