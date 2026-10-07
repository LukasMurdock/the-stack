CREATE TABLE `turret_issue_feedback` (
	`feedback_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feedback_id`) REFERENCES `turret_user_feedback`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `turret_issue_feedback_fingerprint_idx` ON `turret_issue_feedback` (`fingerprint`);