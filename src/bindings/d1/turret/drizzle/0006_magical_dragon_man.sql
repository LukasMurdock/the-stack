CREATE TABLE `turret_issue_state` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_issue_state_status_updatedAt_idx` ON `turret_issue_state` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `turret_errors_fingerprint_ts_idx` ON `turret_session_errors` (`fingerprint`,`ts`);