CREATE TABLE `turret_user_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_email` text,
	`ts` integer NOT NULL,
	`url` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`contact` text,
	`extra_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_feedback_sessionId_ts_idx` ON `turret_user_feedback` (`session_id`,`ts`);--> statement-breakpoint
CREATE INDEX `turret_feedback_status_createdAt_idx` ON `turret_user_feedback` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `turret_feedback_userId_idx` ON `turret_user_feedback` (`user_id`);--> statement-breakpoint
CREATE INDEX `turret_feedback_expiresAt_idx` ON `turret_user_feedback` (`expires_at`);