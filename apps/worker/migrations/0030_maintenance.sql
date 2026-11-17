ALTER TABLE `messages` ADD `inbound_repair_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_inbound_pending` ON `messages` (`created_at`) WHERE "messages"."direction" = 'inbound' AND "messages"."status" = 'pending';--> statement-breakpoint
UPDATE `users` SET `auth_version_migrated` = 1 WHERE `auth_version_migrated` = 0;
