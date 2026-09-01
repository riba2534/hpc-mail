CREATE TABLE `idempotency_records` (
	`actor_type` text NOT NULL,
	`actor_id` integer NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`error_detail` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`actor_type`, `actor_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_created` ON `idempotency_records` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expiry` ON `sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `ingest_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `references` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_created_id` ON `messages` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_message_id` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_in_reply_to` ON `messages` (`in_reply_to`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_ingest_key` ON `messages` (`ingest_key`);--> statement-breakpoint
ALTER TABLE `users` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `trg_users_keep_last_admin_update`
BEFORE UPDATE OF `role`, `status` ON `users`
WHEN OLD.`role` = 'admin'
  AND OLD.`status` = 'active'
  AND (NEW.`role` <> 'admin' OR NEW.`status` <> 'active')
  AND NOT EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` <> OLD.`id` AND `role` = 'admin' AND `status` = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;--> statement-breakpoint
CREATE TRIGGER `trg_users_keep_last_admin_delete`
BEFORE DELETE ON `users`
WHEN OLD.`role` = 'admin'
  AND OLD.`status` = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` <> OLD.`id` AND `role` = 'admin' AND `status` = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'last_active_admin');
END;--> statement-breakpoint
CREATE TRIGGER `trg_users_consume_invite`
AFTER INSERT ON `users`
WHEN NEW.`invite_id` IS NOT NULL
BEGIN
  UPDATE `invites`
  SET `used_count` = `used_count` + 1
  WHERE `id` = NEW.`invite_id`
    AND `status` = 'active'
    AND `used_count` < `max_uses`
    AND (`expires_at` IS NULL OR `expires_at` > (unixepoch() * 1000));
  SELECT (CASE WHEN changes() = 0 THEN RAISE(ABORT, 'invite_invalid') END);
END;
