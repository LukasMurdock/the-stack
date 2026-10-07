ALTER TABLE `turret_issue_state` ADD `resolved_in_version_id` text;--> statement-breakpoint
ALTER TABLE `turret_issue_state` ADD `priority` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `turret_session_errors` ADD `deployment_id` text;--> statement-breakpoint
-- Worker errors recorded their version in metadata; client errors take the
-- version that served their replay session.
UPDATE `turret_session_errors` SET `deployment_id` = CASE
	WHEN `source` = 'worker' AND json_valid(`extra_json`)
		THEN json_extract(`extra_json`, '$.worker_version')
	ELSE (
		SELECT `worker_version_id` FROM `turret_sessions` s
		WHERE s.`session_id` = `turret_session_errors`.`session_id`
	)
END;
