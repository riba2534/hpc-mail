CREATE INDEX `idx_messages_live` ON `messages` (`deleted_at`,`id`,`address`,`direction`,`is_read`);--> statement-breakpoint
CREATE INDEX `idx_messages_visible` ON `messages` (`address`,`deleted_at`,`direction`,`is_read`);--> statement-breakpoint
CREATE INDEX `idx_messages_purge_token` ON `messages` (`purge_token`) WHERE "messages"."purge_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_body_r2` ON `messages` (`body_r2_key`) WHERE "messages"."body_r2_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_raw_r2` ON `messages` (`raw_r2_key`) WHERE "messages"."raw_r2_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_notification_user_channel` ON `notification_jobs` (`user_id`,`channel`,`id`);--> statement-breakpoint
DROP INDEX `idx_messages_direction`;--> statement-breakpoint
DROP INDEX `idx_messages_deleted`;--> statement-breakpoint
DROP INDEX `idx_messages_direction_read`;
