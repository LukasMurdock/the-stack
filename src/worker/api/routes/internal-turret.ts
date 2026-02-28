import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import { createAuth, type AuthEnv } from "../../auth";

type D1Database = globalThis.D1Database;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function startOfUtcWeekMs(ms: number): number {
	// Monday 00:00:00 UTC
	const d = new Date(ms);
	const day = d.getUTCDay();
	const daysSinceMonday = (day + 6) % 7;
	const startOfDay = Date.UTC(
		d.getUTCFullYear(),
		d.getUTCMonth(),
		d.getUTCDate()
	);
	return startOfDay - daysSinceMonday * DAY_MS;
}

function pctDelta(current: number, previous: number): number | null {
	if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
	if (previous === 0) return null;
	return ((current - previous) / previous) * 100;
}

const SAFE_LIKE = /[%_\\]/g;
function escapeLike(input: string): string {
	return input.replace(SAFE_LIKE, (m) => `\\${m}`);
}

const internalTurretApp = new OpenAPIHono();

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

const SessionsResponseSchema = z
	.object({
		sessions: z.array(z.unknown()),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretSessionsResponse");

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

const SessionMetaResponseSchema = z
	.object({
		session: z.unknown(),
	})
	.openapi("TurretSessionMetaResponse");

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
		spans: z.array(z.unknown()),
	})
	.openapi("TurretSpansResponse");

const getSessionBreadcrumbs = createRoute({
	method: "get",
	path: "/internal/turret/session/{id}/breadcrumbs",
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
			description: "List request breadcrumbs for a turret session",
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

const getSessionErrors = createRoute({
	method: "get",
	path: "/internal/turret/session/{id}/errors",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "List errors for a turret session",
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

const getSessions = createRoute({
	method: "get",
	path: "/internal/turret/sessions",
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
			.openapi("TurretSessionsQuery"),
	},
	responses: {
		200: {
			description: "List turret sessions",
			content: { "application/json": { schema: SessionsResponseSchema } },
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

const getSessionMeta = createRoute({
	method: "get",
	path: "/internal/turret/session/{id}/meta",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "Get turret session metadata",
			content: {
				"application/json": { schema: SessionMetaResponseSchema },
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
	path: "/internal/turret/session/{id}/chunks",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
	},
	responses: {
		200: {
			description: "List turret chunks for a session",
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
	path: "/internal/turret/session/{id}/chunk/{seq}",
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

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	// Better Auth stores multiple roles as comma-separated values.
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretApp.use("/internal/turret/*", async (c, next) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);

	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const user = session.user as unknown as { role?: string };
	if (!isAdminRole(user.role)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	await next();
});

internalTurretApp.openapi(getHealth, async (c) => {
	// Quick sanity check that the binding exists.
	await (c.env as { TURRET_DB: D1Database }).TURRET_DB.prepare(
		"SELECT 1"
	).first();
	return c.json({ ok: true as const }, 200);
});

internalTurretApp.openapi(getSessions, async (c) => {
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

	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);

	type Ops = {
		eq(a: unknown, b: unknown): unknown;
		or(...args: unknown[]): unknown;
		like(a: unknown, b: string): unknown;
		gte(a: unknown, b: unknown): unknown;
		lte(a: unknown, b: unknown): unknown;
	};

	type TurretSessionRow = {
		hasError: unknown;
		journeyId: unknown;
		initialUrl: unknown;
		lastUrl: unknown;
		startedAt: unknown;
	};

	const filters: Array<(t: TurretSessionRow, ops: Ops) => unknown> = [];

	if (hasError === "1") filters.push((t, ops) => ops.eq(t.hasError, true));
	if (journeyId) filters.push((t, ops) => ops.eq(t.journeyId, journeyId));
	if (q) {
		const qEsc = escapeLike(q.trim());
		filters.push((t, ops) =>
			ops.or(
				ops.like(t.initialUrl, `%${qEsc}%`),
				ops.like(t.lastUrl, `%${qEsc}%`)
			)
		);
	}
	if (from) {
		const fromMs = Number(from);
		if (!Number.isNaN(fromMs))
			filters.push((t, ops) => ops.gte(t.startedAt, new Date(fromMs)));
	}
	if (to) {
		const toMs = Number(to);
		if (!Number.isNaN(toMs))
			filters.push((t, ops) => ops.lte(t.startedAt, new Date(toMs)));
	}

	const rows = await db.query.turretSessions.findMany({
		where: filters.length
			? (((t: any, ops: any) => {
					return ops.and(...filters.map((fn) => fn(t, ops)));
				}) as unknown as never)
			: undefined,
		orderBy: ((t: any, ops: any) => [
			ops.desc(t.startedAt),
		]) as unknown as never,
		limit,
		offset,
	});

	return c.json({ sessions: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getDashboard, async (c) => {
	const env = c.env as unknown as {
		TURRET_DB: D1Database;
		CORE_DB: D1Database;
	};
	const { to: toRaw } = c.req.valid("query");
	const to = toRaw ? Number(toRaw) : Date.now();
	const nowMs = Number.isFinite(to) ? to : Date.now();
	const currentWeekStart = startOfUtcWeekMs(nowMs);

	const totalUsersNowRow = (await env.CORE_DB.prepare(
		"SELECT COUNT(*) AS c FROM auth_user"
	).first()) as { c?: unknown } | null;
	const totalUsersNow = Number(totalUsersNowRow?.c ?? 0);

	const newUsers24hRow = (await env.CORE_DB.prepare(
		"SELECT COUNT(*) AS c FROM auth_user WHERE created_at >= ? AND created_at < ?"
	)
		.bind(nowMs - DAY_MS, nowMs)
		.first()) as { c?: unknown } | null;
	const newUsers24h = Number(newUsers24hRow?.c ?? 0);

	const activeFrom = nowMs - DAY_MS;
	const prevFrom = nowMs - 2 * DAY_MS;
	const activeUsersStmt =
		"SELECT COUNT(DISTINCT user_id) AS c FROM turret_sessions WHERE started_at >= ? AND started_at < ?";
	const [activeRes, prevActiveRes] = await env.TURRET_DB.batch([
		env.TURRET_DB.prepare(activeUsersStmt).bind(activeFrom, nowMs),
		env.TURRET_DB.prepare(activeUsersStmt).bind(prevFrom, activeFrom),
	]);
	const activeUsers24h = Number((activeRes.results?.[0] as any)?.c ?? 0);
	const activeUsersPrev24h = Number(
		(prevActiveRes.results?.[0] as any)?.c ?? 0
	);
	const activeUsersDeltaPct = pctDelta(activeUsers24h, activeUsersPrev24h);

	// 8 completed weeks ending at currentWeekStart (start of this week).
	const weekEnds: number[] = [];
	for (let i = 8; i >= 0; i--) weekEnds.push(currentWeekStart - i * WEEK_MS);
	const totalsBeforeEndStmt =
		"SELECT COUNT(*) AS c FROM auth_user WHERE created_at < ?";
	const totalsBeforeResults = await env.CORE_DB.batch(
		weekEnds.map((end) =>
			env.CORE_DB.prepare(totalsBeforeEndStmt).bind(end)
		)
	);
	const totalsBefore = totalsBeforeResults.map((r: any) =>
		Number((r.results?.[0] as any)?.c ?? 0)
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

	const cohortCounts = await env.CORE_DB.batch(
		cohortStarts.map((start) =>
			env.CORE_DB.prepare(
				"SELECT COUNT(*) AS c FROM auth_user WHERE created_at >= ? AND created_at < ?"
			).bind(start, start + WEEK_MS)
		)
	);
	const cohortSizes = cohortCounts.map((r: any) =>
		Number((r.results?.[0] as any)?.c ?? 0)
	);

	const retainedCounts = await env.TURRET_DB.batch(
		cohortStarts.map((start) =>
			env.TURRET_DB.prepare(
				"SELECT COUNT(DISTINCT p.user_id) AS c FROM turret_user_profile p JOIN turret_user_activity_weekly a ON a.user_id = p.user_id AND a.week_start_ms = ? WHERE p.signed_up_week_start_ms = ?"
			).bind(start + WEEK_MS, start)
		)
	);
	const retained = retainedCounts.map((r: any) =>
		Number((r.results?.[0] as any)?.c ?? 0)
	);

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

internalTurretApp.openapi(getSessionMeta, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const row = await db.query.turretSessions.findFirst({
		where: ((t: any, ops: any) =>
			ops.eq(t.sessionId, sessionId)) as unknown as never,
	});
	if (!row) return c.json({ error: "Not Found" }, 404);
	return c.json({ session: row }, 200);
});

internalTurretApp.openapi(getChunks, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretSessionChunks.findMany({
		where: ((t: any, ops: any) =>
			ops.eq(t.sessionId, sessionId)) as unknown as never,
	});
	return c.json({ chunks: rows }, 200);
});

internalTurretApp.openapi(getSessionErrors, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretSessionErrors.findMany({
		where: ((t: any, ops: any) =>
			ops.eq(t.sessionId, sessionId)) as unknown as never,
		orderBy: ((t: any, ops: any) => [ops.asc(t.ts)]) as unknown as never,
	});
	return c.json({ errors: rows }, 200);
});

internalTurretApp.openapi(getSessionBreadcrumbs, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const { limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const limit = Number(limitRaw ?? "200");
	const offset = Number(offsetRaw ?? "0");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretRequestBreadcrumbs.findMany({
		where: ((t: any, ops: any) =>
			ops.eq(t.sessionId, sessionId)) as unknown as never,
		orderBy: ((t: any, ops: any) => [ops.asc(t.ts)]) as unknown as never,
		limit,
		offset,
	});
	return c.json({ breadcrumbs: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getRequestSpans, async (c) => {
	const { requestId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretRequestSpans.findMany({
		where: ((t: any, ops: any) =>
			ops.eq(t.requestId, requestId)) as unknown as never,
		orderBy: ((t: any, ops: any) => [
			ops.asc(t.createdAt),
		]) as unknown as never,
	});
	return c.json({ spans: rows }, 200);
});

internalTurretApp.openapi(getChunk, (async (c: unknown) => {
	const ctx = c as any;
	const { id: sessionId, seq: seqRaw } = ctx.req.valid("param");
	const seq = Number(seqRaw);
	const db = makeTurretDb((ctx.env as { TURRET_DB: D1Database }).TURRET_DB);

	const chunk = await db.query.turretSessionChunks.findFirst({
		where: ((t: any, ops: any) =>
			ops.and(
				ops.eq(t.sessionId, sessionId),
				ops.eq(t.seq, seq)
			)) as unknown as never,
	});
	if (!chunk) return ctx.json({ error: "Not Found" }, 404);

	const obj = await (
		ctx.env as {
			TURRET_REPLAY_BUCKET: {
				get(
					key: string
				): Promise<{ body: ReadableStream<Uint8Array> } | null>;
			};
		}
	).TURRET_REPLAY_BUCKET.get((chunk as unknown as { r2Key: string }).r2Key);
	if (!obj) return ctx.json({ error: "Not Found" }, 404);

	return new Response(obj.body, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}) as unknown as never);

export { internalTurretApp };
export const routes = internalTurretApp;
