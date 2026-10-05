import type { Bindings } from "../../index";
import type { TypedResponse } from "hono";
import type { JSONValue } from "hono/utils/types";
import { and, eq, or, like, gte, lte, type SQL } from "drizzle-orm";
import { turretSessions } from "../../../bindings/d1/turret/schema";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import {
	turretRequestSpanSchema,
	turretReplaySessionSpansGroupedResponseSchema,
} from "../../../contracts/turret";
import { requireInternalTurretAdmin } from "./_shared/admin-auth";
import {
	loadReplaySessionSpansGrouped,
	normalizeReplaySessionSpansPagination,
} from "./_shared/session-spans";
import { startOfUtcWeekMs } from "./_shared/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function pctDelta(current: number, previous: number): number | null {
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
	if (previous === 0) return null;
	return ((current - previous) / previous) * 100;
}

const SAFE_LIKE = /[%_\\]/g;
function escapeLike(input: string): string {
	return input.replace(SAFE_LIKE, (m) => `\\${m}`);
}

const internalTurretApp = new OpenAPIHono<{ Bindings: Bindings }>();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const HealthResponseSchema = z
	.object({
		ok: z.literal(true),
	})
	.openapi("HealthResponse");

const ReplaySessionsResponseSchema = z
	.object({
		sessions: z.array(z.unknown()),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretReplaySessionsResponse");

const WeeklyPointSchema = z.object({
	weekStartMs: z.number(),
	value: z.number(),
});
const WeeklyPointNullableSchema = z.object({
	weekStartMs: z.number(),
	value: z.number().nullable(),
});

const DashboardResponseSchema = z
	.object({
		activeUsers24h: z.number(),
		activeUsersPrev24h: z.number(),
		activeUsersDeltaPct: z.number().nullable(),
		newUsers24h: z.number(),
		totalUsersNow: z.number(),
		totalUsersPrevWeek: z.number(),
		totalUsersDeltaPct: z.number().nullable(),
		seriesTotalUsersWeekly: z.array(WeeklyPointSchema),
		seriesNewUsersWeekly: z.array(WeeklyPointSchema),
		seriesNewUserRetentionWeeklyPct: z.array(WeeklyPointNullableSchema),
		newUsersDeltaPctWoW: z.number().nullable(),
		retentionDeltaPctWoW: z.number().nullable(),
	})
	.openapi("TurretDashboardResponse");

const ReplaySessionMetaResponseSchema = z
	.object({
		session: z.unknown(),
	})
	.openapi("TurretReplaySessionMetaResponse");

const ChunksResponseSchema = z
	.object({
		chunks: z.array(z.unknown()),
	})
	.openapi("TurretChunksResponse");

const ErrorsResponseSchema = z
	.object({
		errors: z.array(z.unknown()),
	})
	.openapi("TurretErrorsResponse");

const BreadcrumbsResponseSchema = z
	.object({
		breadcrumbs: z.array(z.unknown()),
		limit: z.number().optional(),
		offset: z.number().optional(),
	})
	.openapi("TurretBreadcrumbsResponse");

const SpansResponseSchema = z
	.object({
		spans: z.array(turretRequestSpanSchema),
	})
	.openapi("TurretSpansResponse");

const ReplaySessionSpansGroupedResponseSchema =
	turretReplaySessionSpansGroupedResponseSchema;

const getReplaySessionBreadcrumbs = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/breadcrumbs",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
		query: z.object({
			limit: z.string().optional(),
			offset: z.string().optional(),
		}),
	},
	responses: {
		200: {
			description: "List request breadcrumbs for a replay session",
			content: {
				"application/json": { schema: BreadcrumbsResponseSchema },
			},
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

const getRequestSpans = createRoute({
	method: "get",
	path: "/internal/turret/request/{requestId}/spans",
	request: {
		params: z.object({
			requestId: z.string().openapi({ example: "<request-id>" }),
		}),
	},
	responses: {
		200: {
			description: "List spans for a request",
			content: { "application/json": { schema: SpansResponseSchema } },
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

const getReplaySessionSpans = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/spans",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
		query: z.object({
			limit: z.string().optional(),
			offset: z.string().optional(),
		}),
	},
	responses: {
		200: {
			description: "List spans for all requests in a replay session",
			content: {
				"application/json": {
					schema: ReplaySessionSpansGroupedResponseSchema,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		500: {
			description: "Internal Server Error",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

const getReplaySessionErrors = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/errors",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "List errors for a replay session",
			content: { "application/json": { schema: ErrorsResponseSchema } },
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

const getHealth = createRoute({
	method: "get",
	path: "/internal/turret/health",
	responses: {
		200: {
			description: "Turret internal health check",
			content: {
				"application/json": {
					schema: HealthResponseSchema,
				},
			},
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

const getReplaySessions = createRoute({
	method: "get",
	path: "/internal/turret/replay-sessions",
	request: {
		query: z
			.object({
				hasError: z.string().optional(),
				journeyId: z.string().optional(),
				q: z.string().optional(),
				from: z.string().optional(),
				to: z.string().optional(),
				limit: z.string().optional(),
				offset: z.string().optional(),
			})
			.openapi("TurretReplaySessionsQuery"),
	},
	responses: {
		200: {
			description: "List Turret replay sessions",
			content: {
				"application/json": { schema: ReplaySessionsResponseSchema },
			},
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

const getDashboard = createRoute({
	method: "get",
	path: "/internal/turret/dashboard",
	request: {
		query: z.object({ to: z.string().optional() }),
	},
	responses: {
		200: {
			description: "Turret dashboard stats",
			content: {
				"application/json": { schema: DashboardResponseSchema },
			},
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

const getReplaySessionMeta = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/meta",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "Get Turret replay session metadata",
			content: {
				"application/json": { schema: ReplaySessionMetaResponseSchema },
			},
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

const getChunks = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/chunks",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "List replay chunks for a replay session",
			content: { "application/json": { schema: ChunksResponseSchema } },
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

const getChunk = createRoute({
	method: "get",
	path: "/internal/turret/replay-session/{id}/chunk/{seq}",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
			seq: z.string().openapi({ example: "0" }),
		}),
	},
	responses: {
		200: {
			description: "Get a specific chunk JSON",
			content: { "application/json": { schema: z.unknown() } },
		},
		default: {
			description: "Chunk response",
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

internalTurretApp.use("/internal/turret/*", requireInternalTurretAdmin);

internalTurretApp.get("/internal/turret/sessions", (c) => {
	const query = new URL(c.req.url).search;
	return c.redirect(`/api/internal/turret/replay-sessions${query}`, 308);
});
internalTurretApp.get("/internal/turret/session/:id/meta", (c) =>
	c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/meta`,
		308
	)
);
internalTurretApp.get("/internal/turret/session/:id/chunks", (c) =>
	c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/chunks`,
		308
	)
);
internalTurretApp.get("/internal/turret/session/:id/chunk/:seq", (c) =>
	c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/chunk/${c.req.param("seq")}`,
		308
	)
);
internalTurretApp.get("/internal/turret/session/:id/errors", (c) =>
	c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/errors`,
		308
	)
);
internalTurretApp.get("/internal/turret/session/:id/breadcrumbs", (c) => {
	const query = new URL(c.req.url).search;
	return c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/breadcrumbs${query}`,
		308
	);
});
internalTurretApp.get("/internal/turret/session/:id/spans", (c) => {
	const query = new URL(c.req.url).search;
	return c.redirect(
		`/api/internal/turret/replay-session/${c.req.param("id")}/spans${query}`,
		308
	);
});

internalTurretApp.openapi(getHealth, async (c) => {
	// Quick sanity check that the binding exists.
	await c.env.TURRET_DB.prepare("SELECT 1").first();
	return c.json({ ok: true as const }, 200);
});

internalTurretApp.openapi(getReplaySessions, async (c) => {
	const {
		hasError,
		journeyId,
		q,
		from,
		to,
		limit: limitRaw,
		offset: offsetRaw,
	} = c.req.valid("query");
	const limit = Number(limitRaw ?? "50");
	const offset = Number(offsetRaw ?? "0");

	const db = makeTurretDb(c.env.TURRET_DB);

	const filters: (SQL | undefined)[] = [];
	const table = turretSessions;
	if (hasError === "1") filters.push(eq(table.hasError, true));
	if (journeyId) filters.push(eq(table.journeyId, journeyId));
	if (q) {
		const pattern = `%${escapeLike(q.trim())}%`;
		filters.push(
			or(like(table.initialUrl, pattern), like(table.lastUrl, pattern))
		);
	}
	if (from && !Number.isNaN(Number(from)))
		filters.push(gte(table.startedAt, new Date(Number(from))));
	if (to && !Number.isNaN(Number(to)))
		filters.push(lte(table.startedAt, new Date(Number(to))));

	const rows = await db.query.turretSessions.findMany({
		where: and(...filters),
		orderBy: (t, ops) => [ops.desc(t.startedAt)],
		limit,
		offset,
	});

	return c.json({ sessions: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getDashboard, async (c) => {
	const env = c.env;
	const { to: toRaw } = c.req.valid("query");
	const to = toRaw ? Number(toRaw) : Date.now();
	const nowMs = Number.isFinite(to) ? to : Date.now();
	const currentWeekStart = startOfUtcWeekMs(nowMs);

	const totalUsersNowRow = await env.CORE_DB.prepare(
		"SELECT COUNT(*) AS c FROM auth_user"
	).first<{ c: number }>();
	const totalUsersNow = Number(totalUsersNowRow?.c ?? 0);

	const newUsers24hRow = await env.CORE_DB.prepare(
		"SELECT COUNT(*) AS c FROM auth_user WHERE created_at >= ? AND created_at < ?"
	)
		.bind(nowMs - DAY_MS, nowMs)
		.first<{ c: number }>();
	const newUsers24h = Number(newUsers24hRow?.c ?? 0);

	const activeFrom = nowMs - DAY_MS;
	const prevFrom = nowMs - 2 * DAY_MS;
	const activeUsersStmt =
		"SELECT COUNT(DISTINCT user_id) AS c FROM turret_sessions WHERE started_at >= ? AND started_at < ?";
	const [activeRes, prevActiveRes] = await env.TURRET_DB.batch<{ c: number }>(
		[
			env.TURRET_DB.prepare(activeUsersStmt).bind(activeFrom, nowMs),
			env.TURRET_DB.prepare(activeUsersStmt).bind(prevFrom, activeFrom),
		]
	);
	const activeUsers24h = Number(activeRes.results?.[0]?.c ?? 0);
	const activeUsersPrev24h = Number(prevActiveRes.results?.[0]?.c ?? 0);
	const activeUsersDeltaPct = pctDelta(activeUsers24h, activeUsersPrev24h);

	// 8 completed weeks ending at currentWeekStart (start of this week).
	const weekEnds: number[] = [];
	for (let i = 8; i >= 0; i--) weekEnds.push(currentWeekStart - i * WEEK_MS);
	const totalsBeforeEndStmt =
		"SELECT COUNT(*) AS c FROM auth_user WHERE created_at < ?";
	const totalsBeforeResults = await env.CORE_DB.batch<{ c: number }>(
		weekEnds.map((end) =>
			env.CORE_DB.prepare(totalsBeforeEndStmt).bind(end)
		)
	);
	const totalsBefore = totalsBeforeResults.map((r) =>
		Number(r.results?.[0]?.c ?? 0)
	);
	const totalUsersPrevWeek = totalsBefore[totalsBefore.length - 1] ?? 0;
	const totalUsersDeltaPct = pctDelta(totalUsersNow, totalUsersPrevWeek);

	const seriesTotalUsersWeekly = totalsBefore
		.slice(1)
		.map((value: number, idx: number) => {
			const end = weekEnds[idx + 1];
			return { weekStartMs: end - WEEK_MS, value };
		});
	const seriesNewUsersWeekly = totalsBefore
		.slice(1)
		.map((_: number, idx: number) => {
			const end = weekEnds[idx + 1];
			const value = totalsBefore[idx + 1] - totalsBefore[idx];
			return { weekStartMs: end - WEEK_MS, value };
		});
	const newUsersDeltaPctWoW = pctDelta(
		seriesNewUsersWeekly[seriesNewUsersWeekly.length - 1]?.value ?? 0,
		seriesNewUsersWeekly[seriesNewUsersWeekly.length - 2]?.value ?? 0
	);

	// New-user retention: signups in week W who are active in week W+1.
	// We expose 8 stable cohort weeks: (currentWeekStart - 9w) .. (currentWeekStart - 2w)
	const cohortStarts: number[] = [];
	for (let i = 9; i >= 2; i--)
		cohortStarts.push(currentWeekStart - i * WEEK_MS);

	const cohortCounts = await env.CORE_DB.batch<{ c: number }>(
		cohortStarts.map((start) =>
			env.CORE_DB.prepare(
				"SELECT COUNT(*) AS c FROM auth_user WHERE created_at >= ? AND created_at < ?"
			).bind(start, start + WEEK_MS)
		)
	);
	const cohortSizes = cohortCounts.map((r) => Number(r.results?.[0]?.c ?? 0));

	const retainedCounts = await env.TURRET_DB.batch<{ c: number }>(
		cohortStarts.map((start) =>
			env.TURRET_DB.prepare(
				"SELECT COUNT(DISTINCT p.user_id) AS c FROM turret_user_profile p JOIN turret_user_activity_weekly a ON a.user_id = p.user_id AND a.week_start_ms = ? WHERE p.signed_up_week_start_ms = ?"
			).bind(start + WEEK_MS, start)
		)
	);
	const retained = retainedCounts.map((r) => Number(r.results?.[0]?.c ?? 0));

	const seriesNewUserRetentionWeeklyPct = cohortStarts.map((start, idx) => {
		const denom = cohortSizes[idx] ?? 0;
		const num = retained[idx] ?? 0;
		const value = denom === 0 ? null : (num / denom) * 100;
		return { weekStartMs: start, value };
	});
	const lastRetention =
		seriesNewUserRetentionWeeklyPct[
			seriesNewUserRetentionWeeklyPct.length - 1
		]?.value;
	const prevRetention =
		seriesNewUserRetentionWeeklyPct[
			seriesNewUserRetentionWeeklyPct.length - 2
		]?.value;
	const retentionDeltaPctWoW =
		lastRetention == null || prevRetention == null
			? null
			: pctDelta(lastRetention, prevRetention);

	return c.json(
		{
			activeUsers24h,
			activeUsersPrev24h,
			activeUsersDeltaPct,
			newUsers24h,
			totalUsersNow,
			totalUsersPrevWeek,
			totalUsersDeltaPct,
			seriesTotalUsersWeekly,
			seriesNewUsersWeekly,
			seriesNewUserRetentionWeeklyPct,
			newUsersDeltaPctWoW,
			retentionDeltaPctWoW,
		},
		200
	);
});

internalTurretApp.openapi(getReplaySessionMeta, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb(c.env.TURRET_DB);
	const row = await db.query.turretSessions.findFirst({
		where: (t, ops) => ops.eq(t.sessionId, sessionId),
	});
	if (!row) return c.json({ error: "Not Found" }, 404);
	return c.json({ session: row }, 200);
});

internalTurretApp.openapi(getChunks, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb(c.env.TURRET_DB);
	const rows = await db.query.turretSessionChunks.findMany({
		where: (t, ops) => ops.eq(t.sessionId, sessionId),
	});
	return c.json({ chunks: rows }, 200);
});

internalTurretApp.openapi(getReplaySessionErrors, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb(c.env.TURRET_DB);
	const rows = await db.query.turretSessionErrors.findMany({
		where: (t, ops) => ops.eq(t.sessionId, sessionId),
		orderBy: (t, ops) => [ops.asc(t.ts)],
	});
	return c.json({ errors: rows }, 200);
});

internalTurretApp.openapi(getReplaySessionBreadcrumbs, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const { limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const limit = Number(limitRaw ?? "200");
	const offset = Number(offsetRaw ?? "0");
	const db = makeTurretDb(c.env.TURRET_DB);
	const rows = await db.query.turretRequestBreadcrumbs.findMany({
		where: (t, ops) => ops.eq(t.sessionId, sessionId),
		orderBy: (t, ops) => [ops.asc(t.ts)],
		limit,
		offset,
	});
	return c.json({ breadcrumbs: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getReplaySessionSpans, async (c) => {
	const env = c.env;
	const { id: sessionId } = c.req.valid("param");
	const { limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const { limit, offset } = normalizeReplaySessionSpansPagination({
		limitRaw,
		offsetRaw,
	});
	const spansResult = await loadReplaySessionSpansGrouped({
		db: env.TURRET_DB,
		sessionId,
		limit,
		offset,
	});
	if (!spansResult.ok) {
		return c.json({ error: spansResult.error }, 500);
	}

	return c.json(
		{
			spansByRequestId: spansResult.spansByRequestId,
			limit,
			offset,
			hasMore: spansResult.hasMore,
		},
		200
	);
});

internalTurretApp.openapi(getRequestSpans, async (c) => {
	const { requestId } = c.req.valid("param");
	const db = makeTurretDb(c.env.TURRET_DB);
	const rows = await db.query.turretRequestSpans.findMany({
		where: (t, ops) => ops.eq(t.requestId, requestId),
		orderBy: (t, ops) => [ops.asc(t.createdAt)],
	});
	return c.json({ spans: rows }, 200);
});

internalTurretApp.openapi(getChunk, async (ctx) => {
	const { id: sessionId, seq: seqRaw } = ctx.req.valid("param");
	const seq = Number(seqRaw);
	const db = makeTurretDb(ctx.env.TURRET_DB);

	const chunk = await db.query.turretSessionChunks.findFirst({
		where: (t, ops) =>
			ops.and(ops.eq(t.sessionId, sessionId), ops.eq(t.seq, seq)),
	});
	if (!chunk) return ctx.json({ error: "Not Found" }, 404);

	const obj = await ctx.env.TURRET_REPLAY_BUCKET.get(chunk.r2Key);
	if (!obj) return ctx.json({ error: "Not Found" }, 404);

	// SAFETY: this Worker stores JSON in R2, and this response sets its JSON content type and 200 status. The Hono marker describes that streaming response without buffering it.
	return new Response(obj.body, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	}) as Response & TypedResponse<JSONValue, 200, "json">;
});

export { internalTurretApp };
export const routes = internalTurretApp;
