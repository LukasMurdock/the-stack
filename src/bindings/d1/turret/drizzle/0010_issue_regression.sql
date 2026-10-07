ALTER TABLE `turret_issue_state` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `turret_issue_state` ADD `regressed_at` integer;--> statement-breakpoint
-- Existing resolved issues use their last edit as an approximate resolution time.
UPDATE `turret_issue_state` SET `resolved_at` = `updated_at` WHERE `status` = 'resolved';
