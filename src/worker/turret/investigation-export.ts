import { sql } from "drizzle-orm";
import type { TurretDb } from "../../bindings/d1/turret/db";
import {
	TURRET_NEARBY_AFTER_MS,
	TURRET_NEARBY_BEFORE_MS,
	TURRET_REPLAY_LEAD_MS,
	type TurretInvestigationExport,
} from "../../contracts/turret-investigation-export";
import { readRecovery } from "./recovery";

const TIMELINE_REQUESTS_MAX = 50;
const TIMELINE_ERRORS_MAX = 50;
const TIMELINE_REPORTS_MAX = 20;
const REPORTS_MAX = 20;
const NOTES_MAX = 50;
// User-provided text is bounded so one report can't dominate the export.
const REPORT_TEXT_MAX = 1000;
const TIMELINE_TEXT_MAX = 300;

function clip(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

type IssueDetail = {
	fingerprint: string;
	title: string | null;
	status: string;
	priority: string;
	resolvedAt: number | null;
	resolvedInVersionId: string | null;
	regressedAt: number | null;
	firstSeenAt: number;
	lastSeenAt: number;
	occurrencesTotal: number;
	reportsTotal: number;
	sessionsAffectedTotal: number;
	usersAffectedTotal: number;
	deployments: Array<{
		deploymentId: string | null;
		occurrences: number;
		firstSeenAt: number;
		lastSeenAt: number;
	}>;
	links: Array<{ url: string }>;
};

type OccurrenceContext = {
	occurrence: {
		id: string;
		sessionId: string | null;
		ts: number;
		source: string;
		message: string | null;
		stack: string | null;
		replayAvailable: boolean;
		correlation: {
			requestId: string | null;
			rayId: string | null;
			workerVersion: string | null;
			route: string | null;
			status: number | null;
		};
	};
	request: {
		id: string;
		method: string;
		path: string;
		status: number;
		durationMs: number;
		requestId: string;
		rayId: string | null;
		d1QueriesCount: number;
		d1QueriesTimeMs: number;
		d1RowsRead: number;
		d1RowsWritten: number;
		d1ErrorsCount: number;
	} | null;
	requestSpans: Array<{
		kind: string;
		durationMs: number;
		sqlShape: string | null;
		errorMessage: string | null;
	}>;
};

type Report = {
	id: string;
	sessionId: string;
	ts: number;
	kind: string;
	message: string;
	url: string | null;
	replayAvailable: boolean;
};

// Assembles the export around one focus: an occurrence, a linked report, or
// nothing when the issue has neither.
export async function buildInvestigationExport(input: {
	db: TurretDb;
	appUrl: string;
	issue: IssueDetail;
	focus:
		| { kind: "error"; context: OccurrenceContext }
		| { kind: "report"; report: Report }
		| null;
	now: number;
}): Promise<TurretInvestigationExport> {
	const { db, issue, focus, now } = input;
	const fingerprint = issue.fingerprint;
	const adminUrl = (path: string, search: Record<string, string>) => {
		const url = new URL(`/app/ts_admin/turret/${path}`, input.appUrl);
		for (const [key, value] of Object.entries(search))
			url.searchParams.set(key, value);
		return url.toString();
	};

	const focusTs =
		focus?.kind === "error"
			? focus.context.occurrence.ts
			: focus?.kind === "report"
				? focus.report.ts
				: null;
	const sessionId =
		focus?.kind === "error"
			? focus.context.occurrence.sessionId
			: focus?.kind === "report"
				? focus.report.sessionId
				: null;
	const replayAvailable =
		focus?.kind === "error"
			? focus.context.occurrence.replayAvailable
			: focus?.kind === "report"
				? focus.report.replayAvailable
				: false;
	const replayStart =
		focusTs === null ? null : Math.max(0, focusTs - TURRET_REPLAY_LEAD_MS);
	const focusSearch: Record<string, string> =
		focus?.kind === "error"
			? { event: focus.context.occurrence.id }
			: focus?.kind === "report"
				? { report: focus.report.id }
				: {};

	const window =
		focusTs === null
			? null
			: {
					from: focusTs - TURRET_NEARBY_BEFORE_MS,
					to: focusTs + TURRET_NEARBY_AFTER_MS,
				};
	const inSession = sessionId !== null && window !== null;
	const [requests, errors, sessionReports, reports, notes, recovery] =
		await Promise.all([
			inSession
				? db.all<{
						id: string;
						ts: number;
						method: string;
						path: string;
						status: number;
						durationMs: number;
						d1QueriesCount: number;
						d1QueriesTimeMs: number;
					}>(sql`
					SELECT id, ts, method, path, status, duration_ms AS durationMs,
						d1_queries_count AS d1QueriesCount,
						d1_queries_time_ms AS d1QueriesTimeMs
					FROM turret_request_breadcrumbs
					WHERE session_id = ${sessionId}
						AND ts >= ${window.from} AND ts < ${window.to}
					ORDER BY ts ASC, id ASC LIMIT ${TIMELINE_REQUESTS_MAX}
				`)
				: [],
			inSession
				? db.all<{
						id: string;
						ts: number;
						source: string;
						message: string | null;
						fingerprint: string | null;
					}>(sql`
					SELECT id, ts, source, message, fingerprint
					FROM turret_session_errors
					WHERE session_id = ${sessionId}
						AND ts >= ${window.from} AND ts < ${window.to}
					ORDER BY ts ASC, id ASC LIMIT ${TIMELINE_ERRORS_MAX}
				`)
				: [],
			inSession
				? db.all<{
						id: string;
						ts: number;
						kind: string;
						message: string;
					}>(sql`
					SELECT id, ts, kind, message
					FROM turret_user_feedback
					WHERE session_id = ${sessionId}
						AND ts >= ${window.from} AND ts < ${window.to}
					ORDER BY ts ASC, id ASC LIMIT ${TIMELINE_REPORTS_MAX}
				`)
				: [],
			db.all<{ ts: number; kind: string; message: string }>(sql`
				SELECT fb.ts, fb.kind, fb.message
				FROM turret_issue_feedback l
				JOIN turret_user_feedback fb ON fb.id = l.feedback_id
				WHERE l.fingerprint = ${fingerprint}
				ORDER BY fb.ts DESC, fb.id DESC LIMIT ${REPORTS_MAX}
			`),
			db.all<{ createdAt: number; detailJson: string }>(sql`
				SELECT created_at AS createdAt, detail_json AS detailJson
				FROM turret_issue_activity
				WHERE fingerprint = ${fingerprint} AND kind = 'note'
				ORDER BY created_at ASC, id ASC LIMIT ${NOTES_MAX}
			`),
			readRecovery(db, fingerprint, now),
		]);

	const focusId =
		focus?.kind === "error"
			? focus.context.occurrence.id
			: focus?.kind === "report"
				? focus.report.id
				: null;
	const request = focus?.kind === "error" ? focus.context.request : null;
	const timeline = [
		...requests.map((r) => ({
			ts: r.ts,
			kind: "request" as const,
			summary: `${r.method} ${r.path} → ${r.status} in ${r.durationMs}ms${
				r.d1QueriesCount > 0
					? `, ${r.d1QueriesCount} D1 queries (${r.d1QueriesTimeMs}ms)`
					: ""
			}`,
			focus: r.id === request?.id,
		})),
		...errors.map((e) => ({
			ts: e.ts,
			kind: "error" as const,
			summary: `${e.source}: ${clip(e.message ?? "(no message)", TIMELINE_TEXT_MAX)}${
				e.fingerprint === fingerprint ? " [this issue]" : ""
			}`,
			focus: e.id === focusId,
		})),
		...sessionReports.map((r) => ({
			ts: r.ts,
			kind: "report" as const,
			summary: `${r.kind} report (user-provided): ${clip(r.message, TIMELINE_TEXT_MAX)}`,
			focus: r.id === focusId,
		})),
	]
		.sort((a, b) => a.ts - b.ts)
		.map((entry) => ({ ...entry, offsetMs: entry.ts - (focusTs ?? 0) }));

	const notCaptured = [
		"Browser console output and the visual replay are not included; open the replay to see them.",
		...(focus === null
			? ["The issue has no retained occurrence or report to focus on."]
			: []),
		...(focus !== null && !replayAvailable
			? ["The focused evidence has no playable replay."]
			: []),
		...(focus?.kind === "error" &&
		focus.context.occurrence.correlation.requestId &&
		!request
			? ["No request breadcrumb matched the occurrence's request ID."]
			: []),
		...(focus?.kind === "error" &&
		(focus.context.occurrence.correlation.requestId ||
			focus.context.occurrence.correlation.rayId)
			? [
					"Cloudflare traces are sampled, so this request may have none; search Workers traces by request ID or Ray ID.",
				]
			: []),
		...(focus?.kind === "error" && focus.context.occurrence.stack
			? ["Stacks are runtime stacks; source maps were not applied."]
			: []),
		...(requests.length >= TIMELINE_REQUESTS_MAX
			? [
					`The timeline shows the first ${TIMELINE_REQUESTS_MAX} requests in its window.`,
				]
			: []),
	];

	return {
		version: 1,
		generatedAt: now,
		issue: {
			fingerprint,
			title: issue.title,
			url: adminUrl(
				`issues/${encodeURIComponent(fingerprint)}`,
				focusSearch
			),
			status: issue.status,
			priority: issue.priority,
			resolvedAt: issue.resolvedAt,
			resolvedInDeployment: issue.resolvedInVersionId,
			regressedAt: issue.regressedAt,
			firstSeenAt: issue.firstSeenAt,
			lastSeenAt: issue.lastSeenAt,
			occurrences: issue.occurrencesTotal,
			reports: issue.reportsTotal,
			replaySessions: issue.sessionsAffectedTotal,
			users: issue.usersAffectedTotal,
			deployments: issue.deployments.map((d) => ({
				deployment: d.deploymentId,
				occurrences: d.occurrences,
				firstSeenAt: d.firstSeenAt,
				lastSeenAt: d.lastSeenAt,
			})),
		},
		focus:
			focus?.kind === "error"
				? {
						kind: "error",
						id: focus.context.occurrence.id,
						ts: focus.context.occurrence.ts,
						source: focus.context.occurrence.source,
						message: focus.context.occurrence.message,
						stack: focus.context.occurrence.stack,
						requestId:
							focus.context.occurrence.correlation.requestId,
						rayId: focus.context.occurrence.correlation.rayId,
						deployment:
							focus.context.occurrence.correlation.workerVersion,
						route: focus.context.occurrence.correlation.route,
						httpStatus: focus.context.occurrence.correlation.status,
						request: request
							? {
									method: request.method,
									path: request.path,
									status: request.status,
									durationMs: request.durationMs,
									requestId: request.requestId,
									rayId: request.rayId,
									database: {
										queries: request.d1QueriesCount,
										timeMs: request.d1QueriesTimeMs,
										rowsRead: request.d1RowsRead,
										rowsWritten: request.d1RowsWritten,
										errors: request.d1ErrorsCount,
									},
									spans: focus.context.requestSpans.map(
										(s) => ({
											kind: s.kind,
											durationMs: s.durationMs,
											statement: s.sqlShape,
											error: s.errorMessage,
										})
									),
								}
							: null,
					}
				: focus?.kind === "report"
					? {
							kind: "report",
							id: focus.report.id,
							ts: focus.report.ts,
							reportKind: focus.report.kind,
							message: clip(
								focus.report.message,
								REPORT_TEXT_MAX
							),
							page: focus.report.url,
						}
					: null,
		replay: {
			available: replayAvailable,
			url:
				replayAvailable && sessionId && replayStart !== null
					? adminUrl(
							`replay-sessions/${encodeURIComponent(sessionId)}`,
							{
								t: String(replayStart),
							}
						)
					: null,
		},
		timeline,
		reports: reports.map((r) => ({
			ts: r.ts,
			kind: r.kind,
			message: clip(r.message, REPORT_TEXT_MAX),
		})),
		notes: notes.map((n) => {
			const detail: unknown = JSON.parse(n.detailJson);
			return {
				createdAt: n.createdAt,
				body:
					detail &&
					typeof detail === "object" &&
					"body" in detail &&
					typeof detail.body === "string"
						? detail.body
						: "",
			};
		}),
		links: issue.links.map((link) => link.url),
		recovery: recovery
			? {
					verdict: recovery.verdict,
					sessionsBefore: recovery.before.sessions,
					affectedBefore: recovery.before.affected,
					sessionsAfter: recovery.after.sessions,
					affectedAfter: recovery.after.affected,
				}
			: null,
		notCaptured,
	};
}
