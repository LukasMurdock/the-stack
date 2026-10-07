CREATE TABLE `turret_issue_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_issue_activity_fingerprint_createdAt_idx` ON `turret_issue_activity` (`fingerprint`,`created_at`);--> statement-breakpoint
CREATE TABLE `turret_issue_links` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`url` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turret_issue_links_fingerprint_url_unique` ON `turret_issue_links` (`fingerprint`,`url`);--> statement-breakpoint
ALTER TABLE `turret_issue_state` ADD `assignee_id` text;