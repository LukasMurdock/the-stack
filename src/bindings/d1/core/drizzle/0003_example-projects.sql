-- The removable Projects example. Until this split, 0002 created this table;
-- IF NOT EXISTS keeps databases that applied the old 0002 valid.
CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_organization_idx` ON `projects` (`organization_id`,`created_at`,`id`);
