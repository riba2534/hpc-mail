CREATE TABLE `email_delivery_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_message_id` text,
	`rfc_message_id` text,
	`kind` text NOT NULL,
	`message_id` integer NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`owner_ids` text DEFAULT '[]' NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_delivery_refs_provider` ON `email_delivery_refs` (`provider_message_id`) WHERE "email_delivery_refs"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_delivery_refs_rfc` ON `email_delivery_refs` (`rfc_message_id`) WHERE "email_delivery_refs"."rfc_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_delivery_refs_pending_pair` ON `email_delivery_refs` (`recipient`,`sender`,`id`) WHERE "email_delivery_refs"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_delivery_refs_created` ON `email_delivery_refs` (`created_at`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`sending_domain` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`expires_at` integer,
	`event_id` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suppressions_address_domain` ON `email_suppressions` (`address`,`sending_domain`);--> statement-breakpoint
CREATE INDEX `idx_suppressions_expires` ON `email_suppressions` (`expires_at`) WHERE "email_suppressions"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `email_event_subscriptions` (
	`domain` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`zone_id` text DEFAULT '' NOT NULL,
	`subscription_id` text,
	`status` text NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`checked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
