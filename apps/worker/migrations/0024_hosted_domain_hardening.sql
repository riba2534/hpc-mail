ALTER TABLE `hosted_domains` ADD `sync_lease_until` integer;--> statement-breakpoint
ALTER TABLE `hosted_domains` ADD `zone_missing_at` integer;--> statement-breakpoint
CREATE TABLE `hosted_domain_tombstones` (
	`domain` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`name_servers` text DEFAULT '[]' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`deleted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_hosted_domain_tombstones_deleted` ON `hosted_domain_tombstones` (`deleted_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `hosted_domain_tombstones` (`domain`, `user_id`, `name_servers`, `reason`, `deleted_at`)
SELECT c.`target`, c.`actor_id`,
  CASE WHEN json_valid(c.`ns`) THEN c.`ns` ELSE '[]' END,
  'backfill',
  COALESCE((SELECT MAX(d.`created_at`) FROM `admin_audit_logs` d
    WHERE d.`target` = c.`target` AND d.`action` IN ('hosted_domain.expire', 'hosted_domain.delete')), c.`created_at`)
FROM (
  SELECT a.`target`, a.`actor_id`, a.`created_at`,
    CASE WHEN instr(a.`detail`, 'NS ') > 0 AND length(trim(substr(a.`detail`, instr(a.`detail`, 'NS ') + 3))) > 0
      THEN '["' || replace(trim(substr(a.`detail`, instr(a.`detail`, 'NS ') + 3)), ' / ', '","') || '"]'
      ELSE '[]' END AS `ns`
  FROM `admin_audit_logs` a
  WHERE a.`action` = 'hosted_domain.create'
    AND a.`id` = (SELECT MAX(b.`id`) FROM `admin_audit_logs` b WHERE b.`action` = 'hosted_domain.create' AND b.`target` = a.`target`)
    AND NOT EXISTS (SELECT 1 FROM `hosted_domains` h WHERE h.`domain` = a.`target`)
) c;
