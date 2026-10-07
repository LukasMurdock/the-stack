import { sql } from "drizzle-orm";
import type { TurretDb } from "../../bindings/d1/turret/db";

// A resolved issue is likely fixed only when, at the rate it affected replay
// sessions before resolution, enough sessions have run since that some should
// have been affected, and none were. With at least this many expected, seeing
// none by chance has a probability of about 5% (e^-3).
export const RECOVERY_MIN_EXPECTED_AFFECTED = 3;

export type RecoveryCounts = {
	// Replay sessions started in the period, and how many had issue evidence.
	sessions: number;
	affected: number;
};

export type RecoveryVerdict =
	| "no_baseline"
	| "recurring"
	| "insufficient_traffic"
	| "likely_fixed";

export function assessRecovery(before: RecoveryCounts, after: RecoveryCounts) {
	const rateBefore =
		before.sessions > 0 ? before.affected / before.sessions : null;
	const expectedAffected =
		rateBefore === null ? null : rateBefore * after.sessions;
	let verdict: RecoveryVerdict;
	if (after.affected > 0) verdict = "recurring";
	else if (expectedAffected === null || before.affected === 0)
		verdict = "no_baseline";
	else if (expectedAffected < RECOVERY_MIN_EXPECTED_AFFECTED)
		verdict = "insufficient_traffic";
	else verdict = "likely_fixed";
	return {
		verdict,
		expectedAffected,
		// The chance of observing no affected sessions if nothing had changed.
		chanceUnchanged:
			verdict === "likely_fixed" && expectedAffected !== null
				? Math.exp(-expectedAffected)
				: null,
	};
}

// Before resolution, the rate is measured over up to this much replay traffic.
const RECOVERY_BASELINE_MS = 7 * 24 * 60 * 60 * 1000;

// Replay-session counts around a resolved issue's resolution and their
// assessment; null unless the issue is resolved.
export async function readRecovery(
	db: TurretDb,
	fingerprint: string,
	now: number
) {
	const state = await db.get<
		| { resolvedAt: number | null; resolvedInVersionId: string | null }
		| undefined
	>(sql`
		SELECT resolved_at AS resolvedAt,
			resolved_in_version_id AS resolvedInVersionId
		FROM turret_issue_state
		WHERE fingerprint = ${fingerprint} AND status = 'resolved'
	`);
	if (state?.resolvedAt == null) return null;
	const { resolvedAt, resolvedInVersionId } = state;
	const beforeFrom = resolvedAt - RECOVERY_BASELINE_MS;
	// A session counts as affected when it has an occurrence or linked
	// report. When the fix awaits the next deployment, sessions the old
	// deployment served are excluded from the after period.
	const affected = sql`(
		EXISTS (
			SELECT 1 FROM turret_session_errors e
			WHERE e.session_id = s.session_id AND e.fingerprint = ${fingerprint}
		)
		OR EXISTS (
			SELECT 1 FROM turret_issue_feedback l
			JOIN turret_user_feedback fb ON fb.id = l.feedback_id
			WHERE fb.session_id = s.session_id AND l.fingerprint = ${fingerprint}
		)
	)`;
	const before = sql`(s.started_at >= ${beforeFrom} AND s.started_at < ${resolvedAt})`;
	const after = sql`(s.started_at >= ${resolvedAt} AND s.started_at < ${now}
		AND (${resolvedInVersionId} IS NULL
			OR (s.worker_version_id IS NOT NULL AND s.worker_version_id != ${resolvedInVersionId})))`;
	const counts = await db.get<{
		beforeSessions: number | null;
		beforeAffected: number | null;
		afterSessions: number | null;
		afterAffected: number | null;
	}>(sql`
		SELECT
			SUM(${before}) AS beforeSessions,
			SUM(${before} AND ${affected}) AS beforeAffected,
			SUM(${after}) AS afterSessions,
			SUM(${after} AND ${affected}) AS afterAffected
		FROM turret_sessions s
		WHERE s.started_at >= ${beforeFrom}
	`);
	const beforeCounts = {
		sessions: counts.beforeSessions ?? 0,
		affected: counts.beforeAffected ?? 0,
	};
	const afterCounts = {
		sessions: counts.afterSessions ?? 0,
		affected: counts.afterAffected ?? 0,
	};
	return {
		resolvedAt,
		resolvedInVersionId,
		before: { from: beforeFrom, to: resolvedAt, ...beforeCounts },
		after: { from: resolvedAt, to: now, ...afterCounts },
		...assessRecovery(beforeCounts, afterCounts),
	};
}
