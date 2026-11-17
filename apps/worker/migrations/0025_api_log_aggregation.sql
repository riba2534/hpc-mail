ALTER TABLE `api_request_logs` ADD `request_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_request_logs` ADD `minute` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_logs_minute` ON `api_request_logs` (`api_key_id`,`minute`,`method`,`path`,`status_code`) WHERE "api_request_logs"."minute" IS NOT NULL;
