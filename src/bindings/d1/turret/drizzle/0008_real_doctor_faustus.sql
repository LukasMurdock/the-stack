-- Historical uploads could insert duplicate sequence metadata while overwriting
-- the same R2 key. Keep the latest metadata row for the surviving object.
DELETE FROM turret_session_chunks
WHERE rowid NOT IN (
 SELECT max(rowid) FROM turret_session_chunks GROUP BY session_id, seq
);
--> statement-breakpoint
UPDATE turret_sessions SET chunk_count = (
 SELECT count(*) FROM turret_session_chunks c WHERE c.session_id = turret_sessions.session_id
);
--> statement-breakpoint
DROP INDEX IF EXISTS `turret_chunks_sessionId_seq_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `turret_chunks_sessionId_seq_unique` ON `turret_session_chunks` (`session_id`,`seq`);