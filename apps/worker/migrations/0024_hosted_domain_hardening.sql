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
SELECT o.`target`,
  CASE WHEN o.`transfer` IS NULL THEN o.`actor_id`
    WHEN o.`owner` GLOB '[0-9]*' AND o.`owner` NOT GLOB '*[^0-9]*' THEN CAST(o.`owner` AS INTEGER)
    ELSE 0 END,
  CASE WHEN json_valid(o.`ns`) THEN o.`ns` ELSE '[]' END,
  'backfill',
  COALESCE((SELECT MAX(d.`created_at`) FROM `admin_audit_logs` d
    WHERE d.`target` = o.`target` AND d.`action` IN ('hosted_domain.expire', 'hosted_domain.delete')), o.`created_at`)
FROM (
  SELECT p.*, substr(p.`pid`, 1, instr(p.`pid`, ')') - 1) AS `owner`
  FROM (
    SELECT t.*, CASE WHEN instr(t.`tail`, '(#') > 0 THEN substr(t.`tail`, instr(t.`tail`, '(#') + 2) END AS `pid`
    FROM (
      SELECT c.*, CASE WHEN instr(c.`transfer`, '→ ') > 0 THEN substr(c.`transfer`, instr(c.`transfer`, '→ ') + 2) END AS `tail`
      FROM (
        SELECT a.`target`, a.`actor_id`, a.`created_at`,
          CASE WHEN instr(a.`detail`, 'NS ') > 0 AND length(trim(substr(a.`detail`, instr(a.`detail`, 'NS ') + 3))) > 0
            THEN '["' || replace(trim(substr(a.`detail`, instr(a.`detail`, 'NS ') + 3)), ' / ', '","') || '"]'
            ELSE '[]' END AS `ns`,
          (SELECT x.`detail` FROM `admin_audit_logs` x WHERE x.`action` = 'hosted_domain.transfer' AND x.`target` = a.`target`
            AND x.`id` > a.`id` ORDER BY x.`id` DESC LIMIT 1) AS `transfer`
        FROM `admin_audit_logs` a
        WHERE a.`action` = 'hosted_domain.create'
          AND a.`id` = (SELECT MAX(b.`id`) FROM `admin_audit_logs` b WHERE b.`action` = 'hosted_domain.create' AND b.`target` = a.`target`)
          AND NOT EXISTS (SELECT 1 FROM `hosted_domains` h WHERE h.`domain` = a.`target`)
      ) c
    ) t
  ) p
) o;
