CREATE TABLE `message_translations` (
	`message_id` integer NOT NULL,
	`cache_key` text NOT NULL,
	`translations` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`message_id`, `cache_key`)
);
