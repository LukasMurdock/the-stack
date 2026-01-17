CREATE TABLE `turret_session_chunks` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_chunks_sessionId_seq_idx` ON `turret_session_chunks` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `turret_session_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`ts` integer NOT NULL,
	`source` text NOT NULL,
	`message` text,
	`stack` text,
	`fingerprint` text,
	`extra_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_errors_sessionId_ts_idx` ON `turret_session_errors` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `turret_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`initial_url` text,
	`last_url` text,
	`user_agent` text,
	`country` text,
	`colo` text,
	`journey_id` text,
	`user_id` text NOT NULL,
	`user_email` text,
	`has_error` integer DEFAULT false NOT NULL,
	`capture_blocked` integer DEFAULT false NOT NULL,
	`capture_blocked_reason` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`policy_version` text NOT NULL,
	`retention_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_sessions_startedAt_idx` ON `turret_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `turret_sessions_hasError_idx` ON `turret_sessions` (`has_error`);--> statement-breakpoint
CREATE INDEX `turret_sessions_captureBlocked_idx` ON `turret_sessions` (`capture_blocked`);--> statement-breakpoint
CREATE INDEX `turret_sessions_retentionExpiresAt_idx` ON `turret_sessions` (`retention_expires_at`);--> statement-breakpoint
CREATE INDEX `turret_sessions_journeyId_idx` ON `turret_sessions` (`journey_id`);--> statement-breakpoint
CREATE INDEX `turret_sessions_userId_idx` ON `turret_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `turret_sessions_userEmail_idx` ON `turret_sessions` (`user_email`);