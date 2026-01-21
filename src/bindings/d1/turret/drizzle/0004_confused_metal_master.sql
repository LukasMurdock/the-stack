CREATE TABLE `turret_user_activity_weekly` (
	`user_id` text NOT NULL,
	`week_start_ms` integer NOT NULL,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turret_user_activity_weekly_user_week_unique` ON `turret_user_activity_weekly` (`user_id`,`week_start_ms`);--> statement-breakpoint
CREATE INDEX `turret_user_activity_weekly_weekStart_idx` ON `turret_user_activity_weekly` (`week_start_ms`);--> statement-breakpoint
CREATE INDEX `turret_user_activity_weekly_userId_idx` ON `turret_user_activity_weekly` (`user_id`);--> statement-breakpoint
CREATE TABLE `turret_user_profile` (
	`user_id` text PRIMARY KEY NOT NULL,
	`signed_up_at_ms` integer NOT NULL,
	`signed_up_week_start_ms` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turret_user_profile_signedUpWeek_idx` ON `turret_user_profile` (`signed_up_week_start_ms`);