CREATE TABLE `auth_storage` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `auth_storage_expires_at_idx` ON `auth_storage` (`expires_at`);