-- Feedback is kept from now on, so reports already stored stop expiring too.
-- Replay retention is unchanged: a report can outlive its replay.
UPDATE `turret_user_feedback` SET `expires_at` = NULL;
