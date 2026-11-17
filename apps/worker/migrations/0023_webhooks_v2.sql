CREATE TABLE `webhook_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`addresses` text DEFAULT '[]' NOT NULL,
	`domains` text DEFAULT '[]' NOT NULL,
	`include_body` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`disabled_reason` text DEFAULT '' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_webhook_endpoints_user` ON `webhook_endpoints` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`event_key` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_attempt_at` integer,
	`last_error` text DEFAULT '' NOT NULL,
	`last_http_status` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_deliveries_event` ON `webhook_deliveries` (`endpoint_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_due` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_endpoint` ON `webhook_deliveries` (`endpoint_id`,`id`);
