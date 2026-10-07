CREATE TABLE `turret_outcome_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`succeeded_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`last_failure_reason` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_outcomes_workflow_startedAt_idx` ON `turret_outcome_attempts` (`workflow`,`started_at`);--> statement-breakpoint
CREATE INDEX `turret_outcomes_sessionId_idx` ON `turret_outcome_attempts` (`session_id`);--> statement-breakpoint
CREATE INDEX `turret_outcomes_expiresAt_idx` ON `turret_outcome_attempts` (`expires_at`);