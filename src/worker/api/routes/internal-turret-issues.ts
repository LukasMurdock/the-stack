import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";

type D1Database = globalThis.D1Database;

const DAY_MS = 24 * 60 * 60 * 1000;

const internalTurretIssuesApp = new OpenAPIHono();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const IssueStatusSchema = z
	.enum(["open", "resolved", "ignored"])
	.openapi("TurretIssueStatus");

const IssueSampleSchema = z
	.object({
		errorId: z.string().nullable(),
		sessionId: z.string().nullable(),
		source: z.string().nullable(),
		message: z.string().nullable(),
		ts: z.number().nullable(),
	})
	.openapi("TurretIssueSample");

const IssueListItemSchema = z
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
	.openapi("TurretIssueListItem");

const IssuesListResponseSchema = z
	.object({
		issues: z.array(IssueListItemSchema),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretIssuesListResponse");

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

const TrendPointSchema = z
	.object({
		bucketStartMs: z.number(),
		count: z.number(),
	})
	.openapi("TurretIssueTrendPoint");

const IssueTrendResponseSchema = z
	.object({
		bucket: z.enum(["hour", "day"]),
		from: z.number(),
		to: z.number(),
		points: z.array(TrendPointSchema),
	})
	.openapi("TurretIssueTrendResponse");

const IssueEventSchema = z
	.object({
		id: z.string(),
		sessionId: z.string().nullable(),
		ts: z.number(),
		source: z.string(),
		message: z.string().nullable(),
		stack: z.string().nullable(),
		fingerprint: z.string().nullable(),
		extraJson: z.string().nullable(),
		expiresAt: z.number().nullable(),
		createdAt: z.number(),
	})
	.openapi("TurretIssueEvent");

const IssueEventsResponseSchema = z
	.object({
		events: z.array(IssueEventSchema),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretIssueEventsResponse");

const IssueUpdateSchema = z
	.object({
		status: IssueStatusSchema.optional(),
		title: z.string().max(2000).nullable().optional(),
	})
	.openapi("TurretIssueUpdate");

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretIssuesApp.use("/internal/turret/*", async (c, next) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
	const user = session.user as unknown as { role?: string };
	if (!isAdminRole(user.role)) return c.json({ error: "Forbidden" }, 403);
	await next();
});

const SAFE_LIKE = /[%_\\]/g;
function escapeLike(input: string): string {
	return input.replace(SAFE_LIKE, (m) => `\\${m}`);
}

function parseMs(input: unknown): number | null {
	if (typeof input === "number" && Number.isFinite(input)) return input;
	if (typeof input !== "string" || !input) return null;
	const n = Number(input);
	return Number.isFinite(n) ? n : null;
}

const listIssues = createRoute({
	method: "get",
	path: "/internal/turret/issues",
	request: {
		query: z
			.object({
				status: IssueStatusSchema.optional(),
				q: z.string().optional(),
				from: z.string().optional(),
				to: z.string().optional(),
				limit: z.string().optional(),
				offset: z.string().optional(),
			})
			.openapi("TurretIssuesQuery"),
	},
	responses: {
		200: {
			description: "List issues (fingerprint groups) within a time range",
			content: { "application/json": { schema: IssuesListResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretIssuesApp.openapi(listIssues, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { status: statusRaw, q: qRaw, from, to, limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const now = Date.now();
	const fromMs = parseMs(from) ?? now - DAY_MS;
	const toMs = parseMs(to) ?? now;
	const status = statusRaw ?? "open";
	const limit = Math.max(1, Math.min(200, Number(limitRaw ?? "50") || 50));
	const offset = Math.max(0, Number(offsetRaw ?? "0") || 0);
	const q = (qRaw ?? "").trim();
	const like = q ? `%${escapeLike(q)}%` : "";

	const sqlText = `
		WITH base AS (
			SELECT
				e.fingerprint AS fingerprint,
				MIN(e.ts) AS firstSeenAt,
				MAX(e.ts) AS lastSeenAt,
				COUNT(*) AS occurrences,
				COUNT(DISTINCT e.session_id) AS sessionsAffected
			FROM turret_session_errors e
			WHERE e.fingerprint IS NOT NULL
				AND e.ts >= ? AND e.ts < ?
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
			WHERE COALESCE(s.status, 'open') = ?
				AND (
					? = ''
					OR COALESCE(s.title, '') LIKE ? ESCAPE '\\'
					OR EXISTS (
						SELECT 1
						FROM turret_session_errors e3
						WHERE e3.fingerprint = b.fingerprint
							AND e3.ts >= ? AND e3.ts < ?
							AND (
								COALESCE(e3.message,'') LIKE ? ESCAPE '\\'
								OR COALESCE(e3.stack,'') LIKE ? ESCAPE '\\'
							)
						LIMIT 1
					)
				)
		)
		SELECT
			f.fingerprint AS fingerprint,
			f.status AS status,
			COALESCE(
				f.stateTitle,
				(SELECT e2.message FROM turret_session_errors e2
					WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
					ORDER BY e2.ts DESC
					LIMIT 1)
			) AS title,
			f.firstSeenAt AS firstSeenAt,
			f.lastSeenAt AS lastSeenAt,
			f.occurrences AS occurrences,
			f.sessionsAffected AS sessionsAffected,
			(SELECT e2.id FROM turret_session_errors e2
				WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleErrorId,
			(SELECT e2.session_id FROM turret_session_errors e2
				WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSessionId,
			(SELECT e2.source FROM turret_session_errors e2
				WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSource,
			(SELECT e2.message FROM turret_session_errors e2
				WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleMessage,
			(SELECT e2.ts FROM turret_session_errors e2
				WHERE e2.fingerprint = f.fingerprint AND e2.ts >= ? AND e2.ts < ?
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleTs
		FROM filtered f
		ORDER BY f.lastSeenAt DESC
		LIMIT ? OFFSET ?;
	`;

	const binds: unknown[] = [
		fromMs,
		toMs,
		status,
		q,
		like,
		fromMs,
		toMs,
		like,
		like,
		fromMs,
		toMs,
		fromMs,
		toMs,
		fromMs,
		toMs,
		fromMs,
		toMs,
		fromMs,
		toMs,
		fromMs,
		toMs,
		limit,
		offset,
	];

	const res = await env.TURRET_DB.prepare(sqlText).bind(...binds).all();
	const rows = (res.results ?? []) as any[];

	const issues = rows.map((r) => {
		return {
			fingerprint: String(r.fingerprint),
			status: (r.status ?? "open") as "open" | "resolved" | "ignored",
			title: r.title != null ? String(r.title) : null,
			firstSeenAt: Number(r.firstSeenAt ?? 0),
			lastSeenAt: Number(r.lastSeenAt ?? 0),
			occurrences: Number(r.occurrences ?? 0),
			sessionsAffected: Number(r.sessionsAffected ?? 0),
			sample: {
				errorId: r.sampleErrorId != null ? String(r.sampleErrorId) : null,
				sessionId: r.sampleSessionId != null ? String(r.sampleSessionId) : null,
				source: r.sampleSource != null ? String(r.sampleSource) : null,
				message: r.sampleMessage != null ? String(r.sampleMessage) : null,
				ts: r.sampleTs != null ? Number(r.sampleTs) : null,
			},
		};
	});

	return c.json({ issues, limit, offset }, 200);
});

const getIssue = createRoute({
	method: "get",
	path: "/internal/turret/issue/{fingerprint}",
	request: {
		params: z.object({ fingerprint: z.string().openapi({ example: "v1:abc123" }) }),
	},
	responses: {
		200: {
			description: "Get issue detail",
			content: { "application/json": { schema: IssueDetailResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		404: {
			description: "Not Found",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretIssuesApp.openapi(getIssue, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { fingerprint } = c.req.valid("param");

	const stmt = `
		SELECT
			e.fingerprint AS fingerprint,
			COALESCE(s.status, 'open') AS status,
			s.title AS stateTitle,
			MIN(e.ts) AS firstSeenAt,
			MAX(e.ts) AS lastSeenAt,
			COUNT(*) AS occurrencesTotal,
			COUNT(DISTINCT e.session_id) AS sessionsAffectedTotal,
			(SELECT e2.id FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleErrorId,
			(SELECT e2.session_id FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSessionId,
			(SELECT e2.source FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSource,
			(SELECT e2.message FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleMessage,
			(SELECT e2.ts FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleTs,
			(SELECT e2.message FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS fallbackTitle
		FROM turret_session_errors e
		LEFT JOIN turret_issue_state s ON s.fingerprint = e.fingerprint
		WHERE e.fingerprint = ?
		GROUP BY e.fingerprint;
	`;

	const row = (await env.TURRET_DB.prepare(stmt).bind(fingerprint).first()) as any | null;
	if (!row) return c.json({ error: "Not Found" }, 404);

	const issue = {
		fingerprint: String(row.fingerprint),
		status: (row.status ?? "open") as "open" | "resolved" | "ignored",
		title: row.stateTitle != null ? String(row.stateTitle) : row.fallbackTitle != null ? String(row.fallbackTitle) : null,
		firstSeenAt: Number(row.firstSeenAt ?? 0),
		lastSeenAt: Number(row.lastSeenAt ?? 0),
		occurrencesTotal: Number(row.occurrencesTotal ?? 0),
		sessionsAffectedTotal: Number(row.sessionsAffectedTotal ?? 0),
		sample: {
			errorId: row.sampleErrorId != null ? String(row.sampleErrorId) : null,
			sessionId: row.sampleSessionId != null ? String(row.sampleSessionId) : null,
			source: row.sampleSource != null ? String(row.sampleSource) : null,
			message: row.sampleMessage != null ? String(row.sampleMessage) : null,
			ts: row.sampleTs != null ? Number(row.sampleTs) : null,
		},
	};

	return c.json({ issue }, 200);
});

const getIssueTrend = createRoute({
	method: "get",
	path: "/internal/turret/issue/{fingerprint}/trend",
	request: {
		params: z.object({ fingerprint: z.string() }),
		query: z.object({
			from: z.string().optional(),
			to: z.string().optional(),
			bucket: z.enum(["hour", "day"]).optional(),
		}),
	},
	responses: {
		200: {
			description: "Get issue trend series",
			content: { "application/json": { schema: IssueTrendResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		404: {
			description: "Not Found",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretIssuesApp.openapi(getIssueTrend, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { fingerprint } = c.req.valid("param");
	const { from, to, bucket: bucketRaw } = c.req.valid("query");

	const now = Date.now();
	const toMs = parseMs(to) ?? now;
	const fromMs = parseMs(from) ?? toMs - 7 * DAY_MS;
	const bucket = bucketRaw ?? "day";
	const bucketMs = bucket === "hour" ? 60 * 60 * 1000 : DAY_MS;

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
	const rows = (res.results ?? []) as any[];

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
});

const getIssueEvents = createRoute({
	method: "get",
	path: "/internal/turret/issue/{fingerprint}/events",
	request: {
		params: z.object({ fingerprint: z.string() }),
		query: z.object({
			limit: z.string().optional(),
			offset: z.string().optional(),
		}),
	},
	responses: {
		200: {
			description: "List recent occurrences for an issue",
			content: { "application/json": { schema: IssueEventsResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		404: {
			description: "Not Found",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretIssuesApp.openapi(getIssueEvents, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { fingerprint } = c.req.valid("param");
	const { limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const limit = Math.max(1, Math.min(200, Number(limitRaw ?? "50") || 50));
	const offset = Math.max(0, Number(offsetRaw ?? "0") || 0);

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
	const res = await env.TURRET_DB.prepare(stmt).bind(fingerprint, limit, offset).all();
	const rows = (res.results ?? []) as any[];
	const events = rows.map((r) => ({
		id: String(r.id),
		sessionId: r.sessionId != null ? String(r.sessionId) : null,
		ts: Number(r.ts ?? 0),
		source: String(r.source ?? ""),
		message: r.message != null ? String(r.message) : null,
		stack: r.stack != null ? String(r.stack) : null,
		fingerprint: r.fingerprint != null ? String(r.fingerprint) : null,
		extraJson: r.extraJson != null ? String(r.extraJson) : null,
		expiresAt: r.expiresAt != null ? Number(r.expiresAt) : null,
		createdAt: Number(r.createdAt ?? 0),
	}));

	return c.json({ events, limit, offset }, 200);
});

const patchIssue = createRoute({
	method: "patch",
	path: "/internal/turret/issue/{fingerprint}",
	request: {
		params: z.object({ fingerprint: z.string() }),
		body: {
			required: true,
			content: {
				"application/json": { schema: IssueUpdateSchema },
			},
		},
	},
	responses: {
		200: {
			description: "Update issue triage state",
			content: { "application/json": { schema: IssueDetailResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		404: {
			description: "Not Found",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretIssuesApp.openapi(patchIssue, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { fingerprint } = c.req.valid("param");
	const body = c.req.valid("json");

	const exists = await env.TURRET_DB.prepare(
		"SELECT 1 AS ok FROM turret_session_errors WHERE fingerprint = ? LIMIT 1"
	)
		.bind(fingerprint)
		.first();
	if (!exists) return c.json({ error: "Not Found" }, 404);

	const now = Date.now();
	// Load current state (if any)
	const current = (await env.TURRET_DB.prepare(
		"SELECT fingerprint, status, title FROM turret_issue_state WHERE fingerprint = ?"
	)
		.bind(fingerprint)
		.first()) as any | null;

	const nextStatus = (body.status ?? (current?.status as any) ?? "open") as string;
	const nextTitle = body.title !== undefined ? body.title : current?.title;

	await env.TURRET_DB.prepare(
		`INSERT INTO turret_issue_state (fingerprint, status, title, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(fingerprint) DO UPDATE SET
			status=excluded.status,
			title=excluded.title,
			updated_at=excluded.updated_at`
	)
		.bind(
			fingerprint,
			nextStatus,
			nextTitle ?? null,
			current ? current.created_at ?? now : now,
			now
		)
		.run();

	// Return fresh issue detail.
	// Reuse the same query from getIssue so the response stays consistent.
	const stmt = `
		SELECT
			e.fingerprint AS fingerprint,
			COALESCE(s.status, 'open') AS status,
			s.title AS stateTitle,
			MIN(e.ts) AS firstSeenAt,
			MAX(e.ts) AS lastSeenAt,
			COUNT(*) AS occurrencesTotal,
			COUNT(DISTINCT e.session_id) AS sessionsAffectedTotal,
			(SELECT e2.id FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleErrorId,
			(SELECT e2.session_id FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSessionId,
			(SELECT e2.source FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleSource,
			(SELECT e2.message FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleMessage,
			(SELECT e2.ts FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS sampleTs,
			(SELECT e2.message FROM turret_session_errors e2
				WHERE e2.fingerprint = e.fingerprint
				ORDER BY e2.ts DESC
				LIMIT 1) AS fallbackTitle
		FROM turret_session_errors e
		LEFT JOIN turret_issue_state s ON s.fingerprint = e.fingerprint
		WHERE e.fingerprint = ?
		GROUP BY e.fingerprint;
	`;
	const row = (await env.TURRET_DB.prepare(stmt).bind(fingerprint).first()) as any;
	const issue = {
		fingerprint: String(row.fingerprint),
		status: (row.status ?? "open") as "open" | "resolved" | "ignored",
		title: row.stateTitle != null ? String(row.stateTitle) : row.fallbackTitle != null ? String(row.fallbackTitle) : null,
		firstSeenAt: Number(row.firstSeenAt ?? 0),
		lastSeenAt: Number(row.lastSeenAt ?? 0),
		occurrencesTotal: Number(row.occurrencesTotal ?? 0),
		sessionsAffectedTotal: Number(row.sessionsAffectedTotal ?? 0),
		sample: {
			errorId: row.sampleErrorId != null ? String(row.sampleErrorId) : null,
			sessionId: row.sampleSessionId != null ? String(row.sampleSessionId) : null,
			source: row.sampleSource != null ? String(row.sampleSource) : null,
			message: row.sampleMessage != null ? String(row.sampleMessage) : null,
			ts: row.sampleTs != null ? Number(row.sampleTs) : null,
		},
	};

	return c.json({ issue }, 200);
});

export { internalTurretIssuesApp };
export const routes = internalTurretIssuesApp;
