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
import { commandInput } from "../../../features/shared/context";
import {
	validationHook,
	operationErrorHandler,
	errorResponses,
} from "./_shared/operation-http";
import { productErrors } from "../../../contracts/operation";
import { turretListPageSchema } from "../../../contracts/turret-pagination";
import type { Bindings } from "../../index";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { turretIssueStatusSchema } from "../../../contracts/turret";
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

const IssueDetailSchema = z
	.object({
		fingerprint: z.string(),
		status: IssueStatusSchema,
		title: z.string().nullable(),
		firstSeenAt: z.number(),
		lastSeenAt: z.number(),
		occurrencesTotal: z.number(),
		sessionsAffectedTotal: z.number(),
		sample: IssueSampleSchema,
	})
	.openapi("TurretIssueDetail");

const IssueDetailResponseSchema = z
	.object({
		issue: IssueDetailSchema,
	})
	.openapi("TurretIssueDetailResponse");

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

async function readIssue(db: D1Database, fingerprint: string) {
	const row = await db
		.prepare(`
		WITH totals AS (
			SELECT fingerprint, MIN(ts) AS firstSeenAt, MAX(ts) AS lastSeenAt,
				COUNT(*) AS occurrencesTotal,
				COUNT(DISTINCT session_id) AS sessionsAffectedTotal
			FROM turret_session_errors WHERE fingerprint = ? GROUP BY fingerprint
		)
		SELECT totals.*, COALESCE(state.status, 'open') AS status,
			COALESCE(state.title, sample.message) AS title,
			${issueSampleColumns}
		FROM totals
		LEFT JOIN turret_issue_state state ON state.fingerprint = totals.fingerprint
		JOIN turret_session_errors sample ON sample.id = (
			SELECT e2.id FROM turret_session_errors e2
			WHERE e2.fingerprint = totals.fingerprint
			ORDER BY ${latestIssueErrorOrder} LIMIT 1
		)
	`)
		.bind(fingerprint)
		.first();
	return row
		? IssueDetailSchema.parse({ ...row, sample: issueSample(row) })
		: null;
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
						status: IssueStatusSchema.optional(),
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
												sessionsAffected: z.number(),
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
			const status = statusRaw ?? "open";
			const q = (qRaw ?? "").trim();

			const sqlText = sql`
		WITH base AS (
			SELECT
				e.fingerprint AS fingerprint,
				MIN(e.ts) AS firstSeenAt,
				MAX(e.ts) AS lastSeenAt,
				COUNT(*) AS occurrences,
				COUNT(DISTINCT e.session_id) AS sessionsAffected
			FROM turret_session_errors e
			WHERE e.fingerprint IS NOT NULL
				AND e.ts >= ${fromMs} AND e.ts < ${toMs}
			GROUP BY e.fingerprint
		),
		filtered AS (
			SELECT
				b.fingerprint,
				b.firstSeenAt,
				b.lastSeenAt,
				b.occurrences,
				b.sessionsAffected,
				COALESCE(s.status, 'open') AS status,
				s.title AS stateTitle
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
				)
		)
		SELECT
			f.fingerprint AS fingerprint,
			f.status AS status,
			COALESCE(f.stateTitle, sample.message) AS title,
			f.firstSeenAt AS firstSeenAt,
			f.lastSeenAt AS lastSeenAt,
			f.occurrences AS occurrences,
			f.sessionsAffected AS sessionsAffected,
			${sql.raw(issueSampleColumns)}
		FROM filtered f
		JOIN turret_session_errors sample ON sample.id = (
			SELECT e2.id FROM turret_session_errors e2
			WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ${fromMs} AND e2.ts < ${toMs}
			ORDER BY ${sql.raw(latestIssueErrorOrder)} LIMIT 1
		)
		ORDER BY f.lastSeenAt DESC, f.fingerprint DESC
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
					sessionsAffected: Number(r.sessionsAffected ?? 0),
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

			const issue = await readIssue(env.TURRET_DB, fingerprint);
			if (!issue) return c.json({ error: "Not Found" }, 404);

			return c.json({ issue }, 200);
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

			const exists = await env.TURRET_DB.prepare(
				"SELECT 1 AS ok FROM turret_session_errors WHERE fingerprint = ? LIMIT 1"
			)
				.bind(fingerprint)
				.first();
			if (!exists) return c.json({ error: "Not Found" }, 404);

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

			const exists = await env.TURRET_DB.prepare(
				"SELECT 1 AS ok FROM turret_session_errors WHERE fingerprint = ? LIMIT 1"
			)
				.bind(fingerprint)
				.first();
			if (!exists) return c.json({ error: "Not Found" }, 404);

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
									title: z
										.string()
										.max(2000)
										.nullable()
										.optional(),
								})
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
			// Existence and patch semantics belong to the write statement. Omitted
			// fields retain their current stored value, including concurrent edits.
			const result = await env.TURRET_DB.prepare(`
				INSERT INTO turret_issue_state (fingerprint, status, title, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM turret_session_errors WHERE fingerprint = ?)
				ON CONFLICT(fingerprint) DO UPDATE SET
					status = CASE WHEN ? THEN excluded.status ELSE turret_issue_state.status END,
					title = CASE WHEN ? THEN excluded.title ELSE turret_issue_state.title END,
					updated_at = excluded.updated_at
			`)
				.bind(
					fingerprint,
					body.status ?? "open",
					body.title ?? null,
					now,
					now,
					fingerprint,
					body.status !== undefined ? 1 : 0,
					body.title !== undefined ? 1 : 0
				)
				.run();
			if (result.meta.changes === 0)
				return c.json({ error: "Not Found" }, 404);
			const issue = await readIssue(env.TURRET_DB, fingerprint);
			if (!issue) return c.json({ error: "Not Found" }, 404);

			return c.json({ issue }, 200);
		}
	);
