import { sql } from "drizzle-orm";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import { literalContains } from "../../../bindings/d1/literal-search";
import {
	turretTimeRangeSchema,
	resolveTurretTimeRange,
	turretRangeDurations,
	turretTrendQuerySchema,
	turretTrendBuckets,
	turretTrendBucketSchema,
} from "../../../contracts/turret-time-range";
import { ProductError, commandInput } from "../../../features/shared/context";
import {
	validationHook,
	operationErrorHandler,
	errorResponses,
} from "./_shared/operation-http";
import { productErrors } from "../../../contracts/operation";
import { turretListPageSchema } from "../../../contracts/turret-pagination";
import type { Bindings } from "../../index";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	TURRET_ESCALATION_FACTOR,
	TURRET_ESCALATION_MIN_OCCURRENCES,
	turretIssuePrioritySchema,
	turretIssueResolveInSchema,
	turretIssueSortSchema,
	turretIssueStatusSchema,
	turretIssueViewSchema,
	turretRequestBreadcrumbSchema,
	turretRequestSpanSchema,
} from "../../../contracts/turret";
import { issueActivity, issueHasEvidence } from "../../turret/issues";
import { buildInvestigationExport } from "../../turret/investigation-export";
import { turretInvestigationExportSchema } from "../../../contracts/turret-investigation-export";
import { batchSql } from "../../../bindings/d1/sql-batch";
import { makeCoreDb } from "../../../bindings/d1/core/db";
import { isAdminRole } from "../../../features/auth/policy";
import {
	adminErrorResponseSchema,
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";

const internalTurretIssuesApp = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
internalTurretIssuesApp.onError(operationErrorHandler);

const IssueStatusSchema = turretIssueStatusSchema;

const IssueSampleSchema = z
	.object({
		errorId: z.string().nullable(),
		sessionId: z.string().nullable(),
		source: z.string().nullable(),
		message: z.string().nullable(),
		ts: z.number().nullable(),
	})
	.openapi("TurretIssueSample");

// Resolution is a claim that later occurrences can disprove.
const issueResolutionShape = {
	resolvedAt: z.number().nullable(),
	regressedAt: z.number().nullable(),
	resolvedInVersionId: z.string().nullable(),
};

const IssueLinkSchema = z
	.object({
		id: z.string(),
		url: z.string(),
		createdBy: z.string(),
		createdAt: z.number(),
	})
	.openapi("TurretIssueLink");

const IssueDeploymentSchema = z
	.object({
		deploymentId: z.string().nullable(),
		occurrences: z.number(),
		firstSeenAt: z.number(),
		lastSeenAt: z.number(),
	})
	.openapi("TurretIssueDeployment");

// Sessions, users, and organizations are distinct impact measures. A refresh
// starts a new replay session, so users count distinct session owners.
// Organization membership lives in the core database and is not joined here.

const IssueDetailSchema = z
	.object({
		fingerprint: z.string(),
		status: IssueStatusSchema,
		title: z.string().nullable(),
		firstSeenAt: z.number(),
		lastSeenAt: z.number(),
		occurrencesTotal: z.number(),
		sessionsAffectedTotal: z.number(),
		// Feedback reports linked to the issue.
		reportsTotal: z.number(),
		usersAffectedTotal: z.number(),
		priority: turretIssuePrioritySchema,
		assigneeId: z.string().nullable(),
		links: z.array(IssueLinkSchema),
		...issueResolutionShape,
		sample: IssueSampleSchema,
		// The occurrence an investigation opens first: the latest one with a
		// playable replay, otherwise the latest occurrence. Issues promoted from
		// feedback may have no error occurrences.
		representativeErrorId: z.string().nullable(),
		// Most recent deployments first; unknown deployments group as null.
		deployments: z.array(IssueDeploymentSchema),
	})
	.openapi("TurretIssueDetail");

const IssueDetailResponseSchema = z
	.object({
		issue: IssueDetailSchema,
		// The deployment serving this request, if the runtime reports one.
		currentDeploymentId: z.string().nullable(),
	})
	.openapi("TurretIssueDetailResponse");

const ISSUE_DEPLOYMENTS_MAX = 20;

async function isAdministrator(env: Bindings, userId: string) {
	const user = await makeCoreDb(env.CORE_DB).query.auth_user.findFirst({
		where: (t, ops) => ops.eq(t.id, userId),
		columns: { role: true },
	});
	return isAdminRole(user?.role);
}

async function issueExists(env: Bindings, fingerprint: string) {
	const row = await makeTurretDb(env.TURRET_DB).get<
		{ ok: number } | undefined
	>(sql`SELECT ${issueHasEvidence(fingerprint)} AS ok`);
	return Boolean(row?.ok);
}

function currentDeploymentId(env: Bindings) {
	return env.CF_VERSION_METADATA?.id || null;
}

// All sample fields come from one row. ID breaks timestamp ties consistently.
const latestIssueErrorOrder = "e2.ts DESC, e2.id DESC";
const issueSampleColumns = `
	sample.id AS sampleErrorId,
	sample.session_id AS sampleSessionId,
	sample.source AS sampleSource,
	sample.message AS sampleMessage,
	sample.ts AS sampleTs
`;

function issueSample(row: Record<string, unknown>) {
	return IssueSampleSchema.parse({
		errorId: row.sampleErrorId,
		sessionId: row.sampleSessionId,
		source: row.sampleSource,
		message: row.sampleMessage,
		ts: row.sampleTs,
	});
}

// A replay is playable while its session is retained and has indexed chunks.
const playableReplay = (sessionColumn: string, now: number) => sql`EXISTS (
	SELECT 1 FROM turret_sessions s
	WHERE s.session_id = ${sql.raw(sessionColumn)} AND s.chunk_count > 0
		AND s.retention_expires_at > ${now}
)`;

async function readIssue(db: D1Database, fingerprint: string, now: number) {
	const turretDb = makeTurretDb(db);
	const [rows, deployments, links] = await Promise.all([
		turretDb.all<Record<string, unknown>>(sql`
		WITH evidence AS (
			SELECT e.ts AS ts, e.session_id AS sessionId, ses.user_id AS userId,
				1 AS isError
			FROM turret_session_errors e
			LEFT JOIN turret_sessions ses ON ses.session_id = e.session_id
			WHERE e.fingerprint = ${fingerprint}
			UNION ALL
			SELECT fb.ts, fb.session_id, fb.user_id, 0
			FROM turret_issue_feedback l
			JOIN turret_user_feedback fb ON fb.id = l.feedback_id
			WHERE l.fingerprint = ${fingerprint}
		),
		totals AS (
			SELECT ${fingerprint} AS fingerprint,
				MIN(ts) AS firstSeenAt, MAX(ts) AS lastSeenAt,
				SUM(isError) AS occurrencesTotal,
				COUNT(*) - SUM(isError) AS reportsTotal,
				COUNT(DISTINCT sessionId) AS sessionsAffectedTotal,
				COUNT(DISTINCT userId) AS usersAffectedTotal
			FROM evidence
			HAVING COUNT(*) > 0
		)
		SELECT totals.*, COALESCE(state.status, 'open') AS status,
			COALESCE(state.title, sample.message) AS title,
			state.resolved_at AS resolvedAt,
			state.regressed_at AS regressedAt,
			state.resolved_in_version_id AS resolvedInVersionId,
			COALESCE(state.priority, 'medium') AS priority,
			state.assignee_id AS assigneeId,
			COALESCE((
				SELECT e2.id FROM turret_session_errors e2
				WHERE e2.fingerprint = totals.fingerprint
					AND ${playableReplay("e2.session_id", now)}
				ORDER BY ${sql.raw(latestIssueErrorOrder)} LIMIT 1
			), sample.id) AS representativeErrorId,
			${sql.raw(issueSampleColumns)}
		FROM totals
		LEFT JOIN turret_issue_state state ON state.fingerprint = totals.fingerprint
		LEFT JOIN turret_session_errors sample ON sample.id = (
			SELECT e2.id FROM turret_session_errors e2
			WHERE e2.fingerprint = totals.fingerprint
			ORDER BY ${sql.raw(latestIssueErrorOrder)} LIMIT 1
		)
	`),
		turretDb.all<Record<string, unknown>>(sql`
		SELECT deployment_id AS deploymentId, COUNT(*) AS occurrences,
			MIN(ts) AS firstSeenAt, MAX(ts) AS lastSeenAt
		FROM turret_session_errors WHERE fingerprint = ${fingerprint}
		GROUP BY deployment_id
		ORDER BY lastSeenAt DESC
		LIMIT ${ISSUE_DEPLOYMENTS_MAX}
	`),
		turretDb.all<Record<string, unknown>>(sql`
		SELECT id, url, created_by AS createdBy, created_at AS createdAt
		FROM turret_issue_links WHERE fingerprint = ${fingerprint}
		ORDER BY created_at ASC, id ASC
	`),
	]);
	const row = rows[0];
	return row
		? IssueDetailSchema.parse({
				...row,
				sample: issueSample(row),
				deployments,
				links,
			})
		: null;
}

const IssueOccurrenceRowSchema = z.object({
	id: z.string(),
	sessionId: z.string().nullable(),
	ts: z.number(),
	source: z.string(),
	message: z.string().nullable(),
	stack: z.string().nullable(),
	extraJson: z.string().nullable(),
	replayAvailable: z.union([z.number(), z.boolean()]),
	newerId: z.string().nullable(),
	olderId: z.string().nullable(),
});

const IssueOccurrenceCorrelationSchema = z
	.object({
		requestId: z.string().nullable(),
		rayId: z.string().nullable(),
		workerVersion: z.string().nullable(),
		method: z.string().nullable(),
		route: z.string().nullable(),
		status: z.number().nullable(),
	})
	.openapi("TurretIssueOccurrenceCorrelation");

// Worker capture writes these keys; client errors carry arbitrary extras, so
// each field is read independently and missing or mistyped keys become null.
const capturedString = z.string().nullable().catch(null).default(null);
const capturedExtraSchema = z
	.object({
		request_id: capturedString,
		ray_id: capturedString,
		worker_version: capturedString,
		method: capturedString,
		path: capturedString,
		status: z.number().nullable().catch(null).default(null),
	})
	.catch({
		request_id: null,
		ray_id: null,
		worker_version: null,
		method: null,
		path: null,
		status: null,
	});

function parseExtraJson(extraJson: string | null): unknown {
	if (!extraJson) return null;
	try {
		return JSON.parse(extraJson);
	} catch {
		return null;
	}
}

function occurrenceCorrelation(extraJson: string | null) {
	const extra = capturedExtraSchema.parse(parseExtraJson(extraJson));
	return IssueOccurrenceCorrelationSchema.parse({
		requestId: extra.request_id,
		rayId: extra.ray_id,
		workerVersion: extra.worker_version,
		method: extra.method,
		route: extra.path,
		status: extra.status,
	});
}

const IssueOccurrenceResponseSchema = z
	.object({
		occurrence: IssueOccurrenceRowSchema.extend({
			replayAvailable: z.boolean(),
			correlation: IssueOccurrenceCorrelationSchema,
		}).openapi("TurretIssueOccurrence"),
		request: turretRequestBreadcrumbSchema.nullable(),
		requestSpans: z.array(turretRequestSpanSchema),
	})
	.openapi("TurretIssueOccurrenceResponse");

// One occurrence with its correlation and the request it failed in.
async function readOccurrenceContext(
	d1: D1Database,
	fingerprint: string,
	errorId: string,
	now: number
) {
	// Neighbors follow the occurrence order used by the events list.
	const db = makeTurretDb(d1);
	const row = await db.get<Record<string, unknown> | undefined>(sql`
		SELECT
			e.id, e.session_id AS sessionId, e.ts, e.source, e.message,
			e.stack, e.extra_json AS extraJson,
			${playableReplay("e.session_id", now)} AS replayAvailable,
			(
				SELECT n.id FROM turret_session_errors n
				WHERE n.fingerprint = e.fingerprint
					AND (n.ts > e.ts OR (n.ts = e.ts AND n.id > e.id))
				ORDER BY n.ts ASC, n.id ASC LIMIT 1
			) AS newerId,
			(
				SELECT o.id FROM turret_session_errors o
				WHERE o.fingerprint = e.fingerprint
					AND (o.ts < e.ts OR (o.ts = e.ts AND o.id < e.id))
				ORDER BY o.ts DESC, o.id DESC LIMIT 1
			) AS olderId
		FROM turret_session_errors e
		WHERE e.id = ${errorId} AND e.fingerprint = ${fingerprint}
	`);
	if (!row) return null;

	const occurrence = IssueOccurrenceRowSchema.parse(row);
	const correlation = occurrenceCorrelation(occurrence.extraJson);

	// Caller-supplied request IDs can repeat, so prefer the observation
	// from the same replay session that is closest in time.
	const request = correlation.requestId
		? ((await db.query.turretRequestBreadcrumbs.findFirst({
				where: (t, ops) =>
					ops.eq(t.requestId, correlation.requestId ?? ""),
				orderBy: (t) => [
					sql`${t.sessionId} IS ${occurrence.sessionId} DESC`,
					sql`ABS(${t.ts} - ${occurrence.ts}) ASC`,
				],
			})) ?? null)
		: null;
	const requestSpans = request
		? await db.query.turretRequestSpans.findMany({
				where: (t, ops) => ops.eq(t.breadcrumbId, request.id),
				orderBy: (t, ops) => [ops.asc(t.ts), ops.asc(t.id)],
			})
		: [];

	return {
		occurrence: {
			...occurrence,
			replayAvailable: Boolean(occurrence.replayAvailable),
			correlation,
		},
		request,
		requestSpans,
	};
}

export { internalTurretIssuesApp };

export const routes = internalTurretIssuesApp
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issues",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				query: turretTimeRangeSchema
					.safeExtend({
						status: turretIssueViewSchema.optional(),
						sort: turretIssueSortSchema.optional(),
						// "me", "none", or an administrator's user ID.
						assignee: z.string().min(1).optional(),
						q: z.string().optional(),
						...turretListPageSchema.shape,
					})
					.openapi("TurretIssuesQuery"),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description:
						"List issues (fingerprint groups) within a time range",
					content: {
						"application/json": {
							schema: z
								.object({
									issues: z.array(
										z
											.object({
												fingerprint: z.string(),
												status: IssueStatusSchema,
												title: z.string().nullable(),
												firstSeenAt: z.number(),
												lastSeenAt: z.number(),
												occurrences: z.number(),
												// Linked feedback reports in the window.
												reports: z.number(),
												// Occurrences in the equal-length window before this one.
												previousOccurrences: z.number(),
												sessionsAffected: z.number(),
												usersAffected: z.number(),
												priority:
													turretIssuePrioritySchema,
												assigneeId: z
													.string()
													.nullable(),
												...issueResolutionShape,
												sample: IssueSampleSchema,
											})
											.openapi("TurretIssueListItem")
									),
									limit: z.number(),
									offset: z.number(),
								})
								.openapi("TurretIssuesListResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const env = c.env;
			const {
				status: statusRaw,
				sort: sortRaw,
				assignee,
				q: qRaw,
				from,
				to,
				limit,
				offset,
			} = c.req.valid("query");
			const now = Date.now();
			const { from: fromMs, to: toMs } = commandInput(
				turretTimeRangeSchema.required(),
				resolveTurretTimeRange(
					{ from, to },
					now,
					turretRangeDurations["24h"]
				)
			);
			const view = statusRaw ?? "open";
			const status =
				view === "resolved" || view === "ignored" ? view : "open";
			const previousFromMs = fromMs - (toMs - fromMs);
			const viewFilter = {
				open: sql``,
				resolved: sql``,
				ignored: sql``,
				new: sql`AND f.firstSeenAt >= ${fromMs}`,
				escalating: sql`AND f.occurrences >= ${TURRET_ESCALATION_MIN_OCCURRENCES}
					AND f.occurrences >= ${TURRET_ESCALATION_FACTOR} * f.previousOccurrences`,
				regressed: sql`AND f.regressedAt IS NOT NULL`,
			}[view];
			const order = {
				lastSeen: sql`f.lastSeenAt DESC`,
				users: sql`f.usersAffected DESC, f.occurrences DESC, f.lastSeenAt DESC`,
				occurrences: sql`f.occurrences DESC, f.lastSeenAt DESC`,
				priority: sql`CASE f.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, f.lastSeenAt DESC`,
			}[sortRaw ?? "lastSeen"];
			const assigneeFilter =
				assignee === undefined
					? sql``
					: assignee === "none"
						? sql`AND f.assigneeId IS NULL`
						: sql`AND f.assigneeId = ${assignee === "me" ? c.get("turretAdminId") : assignee}`;
			const q = (qRaw ?? "").trim();

			const sqlText = sql`
		WITH evidence AS (
			SELECT e.fingerprint AS fingerprint, e.ts AS ts,
				e.session_id AS sessionId, ses.user_id AS userId, 1 AS isError
			FROM turret_session_errors e
			LEFT JOIN turret_sessions ses ON ses.session_id = e.session_id
			WHERE e.fingerprint IS NOT NULL
				AND e.ts >= ${fromMs} AND e.ts < ${toMs}
			UNION ALL
			SELECT l.fingerprint, fb.ts, fb.session_id, fb.user_id, 0
			FROM turret_issue_feedback l
			JOIN turret_user_feedback fb ON fb.id = l.feedback_id
			WHERE fb.ts >= ${fromMs} AND fb.ts < ${toMs}
		),
		base AS (
			SELECT
				fingerprint,
				MAX(ts) AS lastSeenAt,
				SUM(isError) AS occurrences,
				COUNT(*) - SUM(isError) AS reports,
				COUNT(DISTINCT sessionId) AS sessionsAffected,
				COUNT(DISTINCT userId) AS usersAffected
			FROM evidence
			GROUP BY fingerprint
		),
		filtered AS (
			SELECT
				b.fingerprint,
				-- First seen across retained evidence, not just this window.
				(
					SELECT MIN(ts) FROM (
						SELECT e4.ts FROM turret_session_errors e4
						WHERE e4.fingerprint = b.fingerprint
						UNION ALL
						SELECT fb4.ts FROM turret_issue_feedback l4
						JOIN turret_user_feedback fb4 ON fb4.id = l4.feedback_id
						WHERE l4.fingerprint = b.fingerprint
					)
				) AS firstSeenAt,
				b.lastSeenAt,
				b.occurrences,
				b.reports,
				(
					SELECT COUNT(*) FROM turret_session_errors e5
					WHERE e5.fingerprint = b.fingerprint
						AND e5.ts >= ${previousFromMs} AND e5.ts < ${fromMs}
				) AS previousOccurrences,
				b.sessionsAffected,
				b.usersAffected,
				COALESCE(s.status, 'open') AS status,
				COALESCE(s.priority, 'medium') AS priority,
				s.assignee_id AS assigneeId,
				s.title AS stateTitle,
				s.resolved_at AS resolvedAt,
				s.regressed_at AS regressedAt,
				s.resolved_in_version_id AS resolvedInVersionId
			FROM base b
			LEFT JOIN turret_issue_state s ON s.fingerprint = b.fingerprint
			WHERE COALESCE(s.status, 'open') = ${status}
				AND (
					${q} = ''
					OR ${literalContains(sql`COALESCE(s.title, '')`, q)}
					OR EXISTS (
						SELECT 1
						FROM turret_session_errors e3
						WHERE e3.fingerprint = b.fingerprint
							AND e3.ts >= ${fromMs} AND e3.ts < ${toMs}
							AND (
								${literalContains(sql`COALESCE(e3.message, '')`, q)}
								OR ${literalContains(sql`COALESCE(e3.stack, '')`, q)}
							)
						LIMIT 1
					)
					OR EXISTS (
						SELECT 1
						FROM turret_issue_feedback l3
						JOIN turret_user_feedback fb3 ON fb3.id = l3.feedback_id
						WHERE l3.fingerprint = b.fingerprint
							AND fb3.ts >= ${fromMs} AND fb3.ts < ${toMs}
							AND ${literalContains(sql`fb3.message`, q)}
						LIMIT 1
					)
				)
		)
		SELECT
			f.fingerprint AS fingerprint,
			f.status AS status,
			COALESCE(f.stateTitle, sample.message) AS title,
			f.firstSeenAt AS firstSeenAt,
			f.lastSeenAt AS lastSeenAt,
			f.occurrences AS occurrences,
			f.reports AS reports,
			f.previousOccurrences AS previousOccurrences,
			f.sessionsAffected AS sessionsAffected,
			f.usersAffected AS usersAffected,
			f.priority AS priority,
			f.assigneeId AS assigneeId,
			f.resolvedAt AS resolvedAt,
			f.regressedAt AS regressedAt,
			f.resolvedInVersionId AS resolvedInVersionId,
			${sql.raw(issueSampleColumns)}
		FROM filtered f
		LEFT JOIN turret_session_errors sample ON sample.id = (
			SELECT e2.id FROM turret_session_errors e2
			WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ${fromMs} AND e2.ts < ${toMs}
			ORDER BY ${sql.raw(latestIssueErrorOrder)} LIMIT 1
		)
		WHERE 1 = 1 ${viewFilter} ${assigneeFilter}
		ORDER BY ${order}, f.fingerprint DESC
		LIMIT ${limit} OFFSET ${offset};
	`;

			const rows = await makeTurretDb(env.TURRET_DB).all<
				Record<string, unknown>
			>(sqlText);

			const issues = rows.map((r) => {
				return {
					fingerprint: String(r.fingerprint),
					status: IssueStatusSchema.parse(r.status ?? "open"),
					title: r.title != null ? String(r.title) : null,
					firstSeenAt: Number(r.firstSeenAt ?? 0),
					lastSeenAt: Number(r.lastSeenAt ?? 0),
					occurrences: Number(r.occurrences ?? 0),
					reports: Number(r.reports ?? 0),
					previousOccurrences: Number(r.previousOccurrences ?? 0),
					sessionsAffected: Number(r.sessionsAffected ?? 0),
					usersAffected: Number(r.usersAffected ?? 0),
					priority: turretIssuePrioritySchema.parse(r.priority),
					assigneeId:
						r.assigneeId != null ? String(r.assigneeId) : null,
					resolvedAt:
						r.resolvedAt != null ? Number(r.resolvedAt) : null,
					regressedAt:
						r.regressedAt != null ? Number(r.regressedAt) : null,
					resolvedInVersionId:
						r.resolvedInVersionId != null
							? String(r.resolvedInVersionId)
							: null,
					sample: issueSample(r),
				};
			});

			return c.json({ issues, limit, offset }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					fingerprint: z.string().openapi({ example: "v1:abc123" }),
				}),
			},
			responses: {
				200: {
					description: "Get issue detail",
					content: {
						"application/json": {
							schema: IssueDetailResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Not Found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const { fingerprint } = c.req.valid("param");

			const issue = await readIssue(
				env.TURRET_DB,
				fingerprint,
				Date.now()
			);
			if (!issue) return c.json({ error: "Not Found" }, 404);

			return c.json(
				{ issue, currentDeploymentId: currentDeploymentId(env) },
				200
			);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/trend",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ fingerprint: z.string() }),
				query: turretTrendQuerySchema,
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "Get issue trend series",
					content: {
						"application/json": {
							schema: z
								.object({
									bucket: turretTrendBucketSchema,
									from: z.number(),
									to: z.number(),
									points: z.array(
										z
											.object({
												bucketStartMs: z.number(),
												count: z.number(),
											})
											.openapi("TurretIssueTrendPoint")
									),
								})
								.openapi("TurretIssueTrendResponse"),
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Not Found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const { fingerprint } = c.req.valid("param");
			const { from, to, bucket: bucketRaw } = c.req.valid("query");

			const now = Date.now();
			const {
				from: fromMs,
				to: toMs,
				bucket,
			} = commandInput(turretTrendQuerySchema.required(), {
				...resolveTurretTimeRange(
					{ from, to },
					now,
					turretRangeDurations["7d"]
				),
				bucket: bucketRaw,
			});
			const bucketMs = turretTrendBuckets[bucket];

			if (!(await issueExists(env, fingerprint)))
				return c.json({ error: "Not Found" }, 404);

			const stmt = `
		SELECT
			(CAST(ts / ? AS INTEGER) * ?) AS bucketStartMs,
			COUNT(*) AS count
		FROM turret_session_errors
		WHERE fingerprint = ?
			AND ts >= ? AND ts < ?
		GROUP BY bucketStartMs
		ORDER BY bucketStartMs ASC;
	`;
			const res = await env.TURRET_DB.prepare(stmt)
				.bind(bucketMs, bucketMs, fingerprint, fromMs, toMs)
				.all();
			const rows = res.results;

			const counts = new Map<number, number>();
			for (const r of rows) {
				const k = Number(r.bucketStartMs);
				const v = Number(r.count);
				if (Number.isFinite(k) && Number.isFinite(v)) counts.set(k, v);
			}

			const start = Math.floor(fromMs / bucketMs) * bucketMs;
			const end = Math.floor((toMs - 1) / bucketMs) * bucketMs;
			const points: Array<{ bucketStartMs: number; count: number }> = [];
			for (let t = start; t <= end; t += bucketMs) {
				points.push({ bucketStartMs: t, count: counts.get(t) ?? 0 });
			}

			return c.json({ bucket, from: fromMs, to: toMs, points }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/events",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ fingerprint: z.string() }),
				query: z.object({
					...turretListPageSchema.shape,
				}),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "List recent occurrences for an issue",
					content: {
						"application/json": {
							schema: z
								.object({
									events: z.array(
										z
											.object({
												id: z.string(),
												sessionId: z
													.string()
													.nullable(),
												ts: z.number(),
												source: z.string(),
												message: z.string().nullable(),
												stack: z.string().nullable(),
												fingerprint: z
													.string()
													.nullable(),
												extraJson: z
													.string()
													.nullable(),
												expiresAt: z
													.number()
													.nullable(),
												createdAt: z.number(),
											})
											.openapi("TurretIssueEvent")
									),
									limit: z.number(),
									offset: z.number(),
								})
								.openapi("TurretIssueEventsResponse"),
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Not Found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const { fingerprint } = c.req.valid("param");
			const { limit, offset } = c.req.valid("query");

			if (!(await issueExists(env, fingerprint)))
				return c.json({ error: "Not Found" }, 404);

			const stmt = `
		SELECT
			id,
			session_id AS sessionId,
			ts,
			source,
			message,
			stack,
			fingerprint,
			extra_json AS extraJson,
			expires_at AS expiresAt,
			created_at AS createdAt
		FROM turret_session_errors
		WHERE fingerprint = ?
		ORDER BY ts DESC
		LIMIT ? OFFSET ?;
	`;
			const res = await env.TURRET_DB.prepare(stmt)
				.bind(fingerprint, limit, offset)
				.all();
			const rows = res.results;
			const events = rows.map((r) => ({
				id: String(r.id),
				sessionId: r.sessionId != null ? String(r.sessionId) : null,
				ts: Number(r.ts ?? 0),
				source: String(r.source ?? ""),
				message: r.message != null ? String(r.message) : null,
				stack: r.stack != null ? String(r.stack) : null,
				fingerprint:
					r.fingerprint != null ? String(r.fingerprint) : null,
				extraJson: r.extraJson != null ? String(r.extraJson) : null,
				expiresAt: r.expiresAt != null ? Number(r.expiresAt) : null,
				createdAt: Number(r.createdAt ?? 0),
			}));

			return c.json({ events, limit, offset }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/event/{errorId}",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					fingerprint: z.string(),
					errorId: z.string(),
				}),
			},
			responses: {
				200: {
					description:
						"Get one issue occurrence with the evidence needed to investigate it",
					content: {
						"application/json": {
							schema: IssueOccurrenceResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Not Found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const { fingerprint, errorId } = c.req.valid("param");
			const context = await readOccurrenceContext(
				c.env.TURRET_DB,
				fingerprint,
				errorId,
				Date.now()
			);
			if (!context) return c.json({ error: "Not Found" }, 404);
			return c.json(context, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/export",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ fingerprint: z.string() }),
				query: z.object({
					// The occurrence or linked report to center on; defaults to the
					// representative occurrence, then the latest report.
					event: z.string().min(1).optional(),
					report: z.string().min(1).optional(),
				}),
			},
			responses: {
				200: {
					description:
						"Export an investigation's observed facts and evidence links",
					content: {
						"application/json": {
							schema: z
								.object(turretInvestigationExportSchema.shape)
								.openapi("TurretInvestigationExport"),
						},
					},
				},
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				...adminErrorResponses,
				404: {
					description: "Issue or focused evidence not found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const { fingerprint } = c.req.valid("param");
			const { event, report: reportId } = c.req.valid("query");
			const now = Date.now();
			const issue = await readIssue(env.TURRET_DB, fingerprint, now);
			if (!issue) return c.json({ error: "Not Found" }, 404);
			const db = makeTurretDb(env.TURRET_DB);

			const errorId = reportId
				? null
				: (event ?? issue.representativeErrorId);
			const context = errorId
				? await readOccurrenceContext(
						env.TURRET_DB,
						fingerprint,
						errorId,
						now
					)
				: null;
			if (errorId && !context) return c.json({ error: "Not Found" }, 404);
			const report = errorId
				? null
				: await db.get<
						| {
								id: string;
								sessionId: string;
								ts: number;
								kind: string;
								message: string;
								url: string | null;
								replayAvailable: number;
						  }
						| undefined
					>(sql`
					SELECT fb.id, fb.session_id AS sessionId, fb.ts, fb.kind,
						fb.message, fb.url,
						${playableReplay("fb.session_id", now)} AS replayAvailable
					FROM turret_issue_feedback l
					JOIN turret_user_feedback fb ON fb.id = l.feedback_id
					WHERE l.fingerprint = ${fingerprint}
						AND (${reportId ?? null} IS NULL OR fb.id = ${reportId ?? null})
					ORDER BY fb.ts DESC, fb.id DESC LIMIT 1
				`);
			if (reportId && !report) return c.json({ error: "Not Found" }, 404);

			const exported = await buildInvestigationExport({
				db,
				appUrl: env.APP_URL,
				issue,
				focus: context
					? { kind: "error", context }
					: report
						? {
								kind: "report",
								report: {
									...report,
									replayAvailable: Boolean(
										report.replayAvailable
									),
								},
							}
						: null,
				now,
			});
			return c.json(turretInvestigationExportSchema.parse(exported), 200);
		}
	)
	.openapi(
		createRoute({
			method: "patch",
			path: "/internal/turret/issue/{fingerprint}",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ fingerprint: z.string() }),
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									status: IssueStatusSchema.optional(),
									// Applies when resolving; defaults to "now".
									resolveIn:
										turretIssueResolveInSchema.optional(),
									priority:
										turretIssuePrioritySchema.optional(),
									// An administrator's user ID, or null to unassign.
									assigneeId: z
										.string()
										.min(1)
										.nullable()
										.optional(),
									title: z
										.string()
										.max(2000)
										.nullable()
										.optional(),
								})
								.refine(
									(body) =>
										body.resolveIn === undefined ||
										body.status === "resolved",
									{
										path: ["resolveIn"],
										error: "Choose when the fix applies only when resolving.",
									}
								)
								.openapi("TurretIssueUpdate"),
						},
					},
				},
			},
			responses: {
				200: {
					description: "Update issue triage state",
					content: {
						"application/json": {
							schema: IssueDetailResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Not Found",
					content: {
						"application/json": {
							schema: adminErrorResponseSchema,
						},
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const { fingerprint } = c.req.valid("param");
			const body = c.req.valid("json");

			const now = Date.now();
			const actorId = c.get("turretAdminId");
			const status = body.status ?? "open";
			const deployment = currentDeploymentId(env);
			if (body.resolveIn === "next_deployment" && !deployment)
				throw new ProductError(
					"invalid_input",
					"This runtime doesn't report its deployment, so the issue can only be resolved now.",
					{ resolveIn: "Resolve now instead." }
				);
			if (
				body.assigneeId &&
				!(await isAdministrator(env, body.assigneeId))
			)
				throw new ProductError(
					"invalid_input",
					"Assign issues to an administrator.",
					{ assigneeId: "Choose an administrator." }
				);
			const resolvedInVersionId =
				status === "resolved" && body.resolveIn === "next_deployment"
					? deployment
					: null;
			const stored = (column: string) =>
				sql`(SELECT ${sql.raw(column)} FROM turret_issue_state WHERE fingerprint = ${fingerprint})`;
			// Activity rows precede the write in one batch, so each compares its
			// new value with the stored one and records only real changes.
			const activity = [
				body.status === undefined
					? null
					: issueActivity({
							fingerprint,
							actorId,
							kind: "status",
							detail: {
								status,
								...(status === "resolved"
									? { resolveIn: body.resolveIn ?? "now" }
									: {}),
							},
							now,
							when: sql`(
								${status} IS NOT COALESCE(${stored("status")}, 'open')
								OR (${status} = 'resolved'
									AND ${resolvedInVersionId} IS NOT ${stored("resolved_in_version_id")})
							)`,
						}),
				body.priority === undefined
					? null
					: issueActivity({
							fingerprint,
							actorId,
							kind: "priority",
							detail: { priority: body.priority },
							now,
							when: sql`${body.priority} IS NOT COALESCE(${stored("priority")}, 'medium')`,
						}),
				body.assigneeId === undefined
					? null
					: issueActivity({
							fingerprint,
							actorId,
							kind: "assignee",
							detail: { assigneeId: body.assigneeId },
							now,
							when: sql`${body.assigneeId} IS NOT ${stored("assignee_id")}`,
						}),
			].filter((statement) => statement !== null);
			// Existence and patch semantics belong to the write statement. Omitted
			// fields retain their current stored value, including concurrent edits.
			// A status change records when resolution began and clears any
			// regression marker; repeating the current status changes neither.
			// Resolving always sets which deployment's occurrences are expected,
			// so resolving again can switch between "now" and "next deployment".
			const setStatus = body.status !== undefined ? 1 : 0;
			const statusChanged = sql`${setStatus} AND excluded.status != turret_issue_state.status`;
			const results = await batchSql(env.TURRET_DB, [
				...activity,
				sql`
				INSERT INTO turret_issue_state (fingerprint, status, title, priority, assignee_id, resolved_at, resolved_in_version_id, regressed_at, created_at, updated_at)
				SELECT ${fingerprint}, ${status}, ${body.title ?? null}, ${body.priority ?? "medium"},
					${body.assigneeId ?? null},
					${status === "resolved" ? now : null},
					${resolvedInVersionId},
					NULL, ${now}, ${now}
				WHERE ${issueHasEvidence(fingerprint)}
				ON CONFLICT(fingerprint) DO UPDATE SET
					resolved_at = CASE WHEN ${statusChanged} THEN excluded.resolved_at ELSE turret_issue_state.resolved_at END,
					resolved_in_version_id = CASE
						WHEN ${setStatus && status === "resolved" ? 1 : 0} THEN excluded.resolved_in_version_id
						WHEN ${statusChanged} THEN NULL
						ELSE turret_issue_state.resolved_in_version_id
					END,
					regressed_at = CASE WHEN ${statusChanged} THEN NULL ELSE turret_issue_state.regressed_at END,
					status = CASE WHEN ${setStatus} THEN excluded.status ELSE turret_issue_state.status END,
					title = CASE WHEN ${body.title !== undefined ? 1 : 0} THEN excluded.title ELSE turret_issue_state.title END,
					priority = CASE WHEN ${body.priority !== undefined ? 1 : 0} THEN excluded.priority ELSE turret_issue_state.priority END,
					assignee_id = CASE WHEN ${body.assigneeId !== undefined ? 1 : 0} THEN excluded.assignee_id ELSE turret_issue_state.assignee_id END,
					updated_at = excluded.updated_at
			`,
			]);
			if ((results.at(-1)?.meta.changes ?? 0) === 0)
				return c.json({ error: "Not Found" }, 404);
			const issue = await readIssue(env.TURRET_DB, fingerprint, now);
			if (!issue) return c.json({ error: "Not Found" }, 404);

			return c.json(
				{ issue, currentDeploymentId: currentDeploymentId(env) },
				200
			);
		}
	);
