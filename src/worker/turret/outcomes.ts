import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { TurretDb } from "../../bindings/d1/turret/db";
import type { turretOutcomeBodySchema } from "../../contracts/turret-outcomes";
import { readTelemetryExpiry } from "./retention";

// Applies one workflow event to its attempt. Events can arrive in any order or
// more than once: the attempt keeps its earliest start and first success, and
// stops changing once it has succeeded. An attempt belongs to the replay
// session that started it; events from another session never alter it.
// Returns false when the replay session no longer exists.
export async function recordOutcomeEvent(
	db: TurretDb,
	sessionId: string,
	event: z.output<typeof turretOutcomeBodySchema>,
	now = Date.now()
) {
	const expiresAt = await readTelemetryExpiry(db, sessionId, now);
	const failed = event.event === "failed";
	const result = await db.run(sql`
		INSERT INTO turret_outcome_attempts (
			id, workflow, session_id, user_id, started_at, last_event_at,
			succeeded_at, failures, last_failure_at, last_failure_reason,
			expires_at, created_at
		)
		SELECT ${event.attemptId}, ${event.workflow}, s.session_id, s.user_id,
			${event.ts}, ${event.ts},
			${event.event === "succeeded" ? event.ts : null},
			${failed ? 1 : 0},
			${failed ? event.ts : null},
			${failed ? (event.reason ?? "error") : null},
			${expiresAt}, ${now}
		FROM turret_sessions s WHERE s.session_id = ${sessionId}
		ON CONFLICT(id) DO UPDATE SET
			started_at = MIN(turret_outcome_attempts.started_at, excluded.started_at),
			last_event_at = MAX(turret_outcome_attempts.last_event_at, excluded.last_event_at),
			succeeded_at = excluded.succeeded_at,
			failures = turret_outcome_attempts.failures + excluded.failures,
			last_failure_at = COALESCE(excluded.last_failure_at, turret_outcome_attempts.last_failure_at),
			last_failure_reason = COALESCE(excluded.last_failure_reason, turret_outcome_attempts.last_failure_reason)
		WHERE turret_outcome_attempts.session_id = excluded.session_id
			AND turret_outcome_attempts.workflow = excluded.workflow
			AND turret_outcome_attempts.succeeded_at IS NULL
	`);
	return result.meta.changes > 0;
}
