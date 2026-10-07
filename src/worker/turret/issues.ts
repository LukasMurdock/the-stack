import { and, eq, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { batchSql } from "../../bindings/d1/sql-batch";
import type { TurretDb } from "../../bindings/d1/turret/db";
import type { TurretIssueActivityKind } from "../../contracts/turret";
import {
	turretIssueFeedback,
	turretIssueState,
	turretSessionErrors,
	turretSessions,
	turretUserFeedback,
} from "../../bindings/d1/turret/schema";

// The deployment that served a replay session, for evidence captured in it.
export function sessionDeployment(sessionId: string) {
	return sql`(SELECT ${turretSessions.workerVersionId} FROM ${turretSessions} WHERE ${turretSessions.sessionId} = ${sessionId})`;
}

// An issue exists while it has retained evidence: error occurrences with its
// fingerprint or feedback reports linked to it.
export function issueHasEvidence(fingerprint: string | SQL) {
	return sql`(
		EXISTS (SELECT 1 FROM ${turretSessionErrors} WHERE ${turretSessionErrors.fingerprint} = ${fingerprint})
		OR EXISTS (SELECT 1 FROM ${turretIssueFeedback} WHERE ${turretIssueFeedback.fingerprint} = ${fingerprint})
	)`;
}

// Evidence after an issue's resolution (an error occurrence or a linked
// report) disproves the fix, so it reopens the issue as regressed. Occurrence time, not arrival time, decides: an error
// captured before resolution but delivered afterward does not regress it.
// An issue resolved for the next deployment still expects occurrences from the
// deployment that was serving when it was resolved. An occurrence from an
// unknown deployment can't be ruled out, so it regresses the issue.
export function reopenResolvedIssue(
	db: TurretDb,
	fingerprint: string,
	ts: Date,
	deployment: SQL,
	now: number,
	// Further conditions the evidence must meet within the same statement.
	guard?: SQL
) {
	return db
		.update(turretIssueState)
		.set({ status: "open", regressedAt: ts, updatedAt: new Date(now) })
		.where(
			and(
				eq(turretIssueState.fingerprint, fingerprint),
				eq(turretIssueState.status, "resolved"),
				lt(turretIssueState.resolvedAt, ts),
				or(
					isNull(turretIssueState.resolvedInVersionId),
					sql`${deployment} IS NULL`,
					ne(turretIssueState.resolvedInVersionId, deployment)
				),
				guard
			)
		);
}

// The fingerprint of an issue promoted from a feedback report. Promoting the
// same report again addresses the same issue.
export function reportIssueFingerprint(feedbackId: string) {
	return `report:${feedbackId}`;
}

function reportIssueTitle(message: string) {
	return (message.split("\n").find((line) => line.trim()) ?? message)
		.trim()
		.slice(0, 200);
}

// Links a report to an issue, moving it from any previous issue. With
// `promote`, the report becomes the first evidence for a new issue; otherwise
// the issue must already have evidence. The link, the report's triage status,
// and any regression it causes commit together. Returns false when the report
// or target issue does not exist.
export async function linkFeedbackToIssue(
	db: TurretDb,
	input: {
		feedbackId: string;
		fingerprint: string;
		promote: boolean;
		now: number;
	}
) {
	const { feedbackId, fingerprint, now } = input;
	const report = await db.query.turretUserFeedback.findFirst({
		where: eq(turretUserFeedback.id, feedbackId),
		columns: { ts: true, sessionId: true, message: true },
	});
	if (!report) return false;
	const linked = sql`EXISTS (
		SELECT 1 FROM turret_issue_feedback
		WHERE feedback_id = ${feedbackId} AND fingerprint = ${fingerprint}
	)`;
	const [, link] = await batchSql(db.$client, [
		input.promote
			? sql`
				INSERT INTO turret_issue_state (fingerprint, status, title, created_at, updated_at)
				VALUES (${fingerprint}, 'open', ${reportIssueTitle(report.message)}, ${now}, ${now})
				ON CONFLICT(fingerprint) DO NOTHING
			`
			: sql`SELECT 1`,
		sql`
			INSERT INTO turret_issue_feedback (feedback_id, fingerprint, created_at)
			SELECT id, ${fingerprint}, ${now} FROM turret_user_feedback
			WHERE id = ${feedbackId}
				AND (${input.promote ? 1 : 0} OR ${issueHasEvidence(fingerprint)})
			ON CONFLICT(feedback_id) DO UPDATE SET
				fingerprint = excluded.fingerprint,
				created_at = excluded.created_at
		`,
		sql`
			UPDATE turret_user_feedback SET status = 'triaged', updated_at = ${now}
			WHERE id = ${feedbackId} AND status = 'open' AND ${linked}
		`,
		reopenResolvedIssue(
			db,
			fingerprint,
			report.ts,
			sessionDeployment(report.sessionId),
			now,
			linked
		).getSQL(),
	]);
	return link.meta.changes > 0;
}

// An activity row for an existing issue. `when` restricts recording to real
// changes, evaluated before the change in the same batch.
export function issueActivity(input: {
	fingerprint: string;
	actorId: string;
	kind: TurretIssueActivityKind;
	detail: unknown;
	now: number;
	when?: SQL;
}) {
	return sql`
		INSERT INTO turret_issue_activity (id, fingerprint, actor_id, kind, detail_json, created_at)
		SELECT ${crypto.randomUUID()}, ${input.fingerprint}, ${input.actorId}, ${input.kind},
			${JSON.stringify(input.detail)}, ${input.now}
		WHERE ${issueHasEvidence(input.fingerprint)} AND ${input.when ?? sql`1`}
	`;
}
