CREATE TABLE `turret_request_breadcrumbs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`session_id` text,
	`ts` integer NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`ray_id` text,
	`colo` text,
	`d1_queries_count` integer DEFAULT 0 NOT NULL,
	`d1_queries_time_ms` integer DEFAULT 0 NOT NULL,
	`d1_rows_read` integer DEFAULT 0 NOT NULL,
	`d1_rows_written` integer DEFAULT 0 NOT NULL,
	`d1_errors_count` integer DEFAULT 0 NOT NULL,
	`error_kind` text,
	`error_message` text,
	`extra_json` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_breadcrumbs_requestId_idx` ON `turret_request_breadcrumbs` (`request_id`);--> statement-breakpoint
CREATE INDEX `turret_breadcrumbs_sessionId_ts_idx` ON `turret_request_breadcrumbs` (`session_id`,`ts`);--> statement-breakpoint
CREATE INDEX `turret_breadcrumbs_ts_idx` ON `turret_request_breadcrumbs` (`ts`);--> statement-breakpoint
CREATE INDEX `turret_breadcrumbs_status_idx` ON `turret_request_breadcrumbs` (`status`);--> statement-breakpoint
CREATE INDEX `turret_breadcrumbs_expiresAt_idx` ON `turret_request_breadcrumbs` (`expires_at`);--> statement-breakpoint
CREATE TABLE `turret_request_spans` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`db` text,
	`duration_ms` integer NOT NULL,
	`sql_shape` text,
	`rows_read` integer,
	`rows_written` integer,
	`error_message` text,
	`extra_json` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_spans_requestId_idx` ON `turret_request_spans` (`request_id`);--> statement-breakpoint
CREATE INDEX `turret_spans_kind_idx` ON `turret_request_spans` (`kind`);--> statement-breakpoint
CREATE INDEX `turret_spans_db_idx` ON `turret_request_spans` (`db`);--> statement-breakpoint
CREATE INDEX `turret_spans_expiresAt_idx` ON `turret_request_spans` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_turret_sessions` (
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
	`worker_version_id` text,
	`worker_version_tag` text,
	`worker_version_timestamp` text,
	`rrweb_start_ts_ms` integer,
	`rrweb_last_ts_ms` integer,
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
INSERT INTO `__new_turret_sessions`("session_id", "started_at", "ended_at", "initial_url", "last_url", "user_agent", "country", "colo", "journey_id", "user_id", "user_email", "worker_version_id", "worker_version_tag", "worker_version_timestamp", "rrweb_start_ts_ms", "rrweb_last_ts_ms", "has_error", "capture_blocked", "capture_blocked_reason", "error_count", "chunk_count", "policy_version", "retention_expires_at", "created_at", "updated_at") SELECT "session_id", "started_at", "ended_at", "initial_url", "last_url", "user_agent", "country", "colo", "journey_id", "user_id", "user_email", "worker_version_id", "worker_version_tag", "worker_version_timestamp", "rrweb_start_ts_ms", "rrweb_last_ts_ms", "has_error", "capture_blocked", "capture_blocked_reason", "error_count", "chunk_count", "policy_version", "retention_expires_at", "created_at", "updated_at" FROM `turret_sessions`;--> statement-breakpoint
DROP TABLE `turret_sessions`;--> statement-breakpoint
ALTER TABLE `__new_turret_sessions` RENAME TO `turret_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `turret_sessions_startedAt_idx` ON `turret_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `turret_sessions_hasError_idx` ON `turret_sessions` (`has_error`);--> statement-breakpoint
CREATE INDEX `turret_sessions_captureBlocked_idx` ON `turret_sessions` (`capture_blocked`);--> statement-breakpoint
CREATE INDEX `turret_sessions_retentionExpiresAt_idx` ON `turret_sessions` (`retention_expires_at`);--> statement-breakpoint
CREATE INDEX `turret_sessions_journeyId_idx` ON `turret_sessions` (`journey_id`);--> statement-breakpoint
CREATE INDEX `turret_sessions_userId_idx` ON `turret_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `turret_sessions_userEmail_idx` ON `turret_sessions` (`user_email`);--> statement-breakpoint
CREATE INDEX `turret_sessions_workerVersionId_idx` ON `turret_sessions` (`worker_version_id`);--> statement-breakpoint
CREATE INDEX `turret_sessions_workerVersionTag_idx` ON `turret_sessions` (`worker_version_tag`);--> statement-breakpoint
CREATE INDEX `turret_sessions_rrwebStartTsMs_idx` ON `turret_sessions` (`rrweb_start_ts_ms`);--> statement-breakpoint
CREATE INDEX `turret_sessions_rrwebLastTsMs_idx` ON `turret_sessions` (`rrweb_last_ts_ms`);