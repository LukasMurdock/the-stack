ALTER TABLE turret_sessions ADD COLUMN worker_version_id text;
ALTER TABLE turret_sessions ADD COLUMN worker_version_tag text;
ALTER TABLE turret_sessions ADD COLUMN worker_version_timestamp text;

CREATE INDEX turret_sessions_workerVersionId_idx ON turret_sessions (worker_version_id);
CREATE INDEX turret_sessions_workerVersionTag_idx ON turret_sessions (worker_version_tag);
