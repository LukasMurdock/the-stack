ALTER TABLE `turret_session_errors` ADD `expires_at` integer;--> statement-breakpoint
CREATE INDEX `turret_errors_expiresAt_idx` ON `turret_session_errors` (`expires_at`);