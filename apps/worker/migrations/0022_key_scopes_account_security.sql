ALTER TABLE `api_keys` ADD `allowed_mailbox_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `allowed_domains` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
UPDATE `api_keys` SET `scopes` = json_insert(`scopes`, '$[#]', 'admin')
WHERE `status` <> 'revoked'
  AND `user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'admin')
  AND NOT EXISTS (SELECT 1 FROM json_each(`api_keys`.`scopes`) WHERE json_each.`value` = 'admin');--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
CREATE TABLE `forward_confirmations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`address` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forward_confirmations_token` ON `forward_confirmations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forward_confirmations_user_address` ON `forward_confirmations` (`user_id`,`address`);
