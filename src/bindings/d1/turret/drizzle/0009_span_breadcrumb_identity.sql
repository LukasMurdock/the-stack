-- Hard cutover: old correlation-only spans do not identify a request observation.
DROP TABLE `turret_request_spans`;--> statement-breakpoint
CREATE TABLE `turret_request_spans` (
	`id` text PRIMARY KEY NOT NULL,
	`breadcrumb_id` text NOT NULL REFERENCES `turret_request_breadcrumbs`(`id`) ON DELETE CASCADE,
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
);--> statement-breakpoint
CREATE INDEX `turret_spans_breadcrumbId_idx` ON `turret_request_spans` (`breadcrumb_id`);--> statement-breakpoint
CREATE INDEX `turret_spans_kind_idx` ON `turret_request_spans` (`kind`);--> statement-breakpoint
CREATE INDEX `turret_spans_db_idx` ON `turret_request_spans` (`db`);--> statement-breakpoint
CREATE INDEX `turret_spans_expiresAt_idx` ON `turret_request_spans` (`expires_at`);
