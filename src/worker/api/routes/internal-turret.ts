import { turretTimeRangeSchema } from "../../../contracts/turret-time-range";
import {
	validationHook,
	operationErrorHandler,
	errorResponses,
} from "./_shared/operation-http";
import { productErrors } from "../../../contracts/operation";
import {
	turretListPageSchema,
	turretBreadcrumbPageSchema,
	turretSpanPageSchema,
} from "../../../contracts/turret-pagination";
import type { Bindings } from "../../index";
import type { TypedResponse } from "hono";
import { readRetainedReplay, retainedReplay } from "../../turret/retention";
import type { JSONParsed } from "hono/utils/types";
import {
	turretHasErrorSchema,
	turretReplayChunkSchema,
} from "../../../contracts/turret";
import {
	and,
	eq,
	or,
	like,
	gte,
	lt,
	countDistinct,
	type SQL,
} from "drizzle-orm";
import { turretSessions } from "../../../bindings/d1/turret/schema";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import {
	turretRequestSpanSchema,
	turretReplaySessionSpansGroupedResponseSchema,
} from "../../../contracts/turret";
import {
	adminErrorResponseSchema,
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";
import { loadReplaySessionSpansGrouped } from "./_shared/session-spans";
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

const replayErrorResponses = {
	...adminErrorResponses,
	404: {
		description: "Replay session not found or expired",
		content: { "application/json": { schema: adminErrorResponseSchema } },
	},
};

const internalTurretApp = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
internalTurretApp.onError(operationErrorHandler);

const TurretReplaySessionSchema = z.object({
	sessionId: z.string(),
	userId: z.string(),
	userEmail: z.string().nullable(),
	workerVersionId: z.string().nullable(),
	workerVersionTag: z.string().nullable(),
	workerVersionTimestamp: z.string().nullable(),
	rrwebStartTsMs: z.string().nullable(),
	rrwebLastTsMs: z.string().nullable(),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	initialUrl: z.string().nullable(),
	lastUrl: z.string().nullable(),
	journeyId: z.string().nullable(),
	userAgent: z.string().nullable(),
	country: z.string().nullable(),
	colo: z.string().nullable(),
	hasError: z.boolean(),
	captureBlocked: z.boolean(),
	captureBlockedReason: z.string().nullable(),
	errorCount: z.number(),
	chunkCount: z.number(),
	policyVersion: z.string(),
	retentionExpiresAt: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

const WeeklyPointSchema = z.object({
	weekStartMs: z.number(),
	value: z.number(),
});

internalTurretApp.get(
	"/internal/turret/sessions",
	requireInternalTurretAdmin,
	(c) => {
		const query = new URL(c.req.url).search;
		return c.redirect(`/api/internal/turret/replay-sessions${query}`, 308);
	}
);
internalTurretApp.get(
	"/internal/turret/session/:id/meta",
	requireInternalTurretAdmin,
	(c) =>
		c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/meta`,
			308
		)
);
internalTurretApp.get(
	"/internal/turret/session/:id/chunks",
	requireInternalTurretAdmin,
	(c) =>
		c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/chunks`,
			308
		)
);
internalTurretApp.get(
	"/internal/turret/session/:id/chunk/:seq",
	requireInternalTurretAdmin,
	(c) =>
		c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/chunk/${c.req.param("seq")}`,
			308
		)
);
internalTurretApp.get(
	"/internal/turret/session/:id/errors",
	requireInternalTurretAdmin,
	(c) =>
		c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/errors`,
			308
		)
);
internalTurretApp.get(
	"/internal/turret/session/:id/breadcrumbs",
	requireInternalTurretAdmin,
	(c) => {
		const query = new URL(c.req.url).search;
		return c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/breadcrumbs${query}`,
			308
		);
	}
);
internalTurretApp.get(
	"/internal/turret/session/:id/spans",
	requireInternalTurretAdmin,
	(c) => {
		const query = new URL(c.req.url).search;
		return c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/spans${query}`,
			308
		);
	}
);

export { internalTurretApp };

export const routes = internalTurretApp
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/health",
			middleware: [requireInternalTurretAdmin] as const,
			responses: {
				200: {
					description: "Turret internal health check",
					content: {
						"application/json": {
							schema: z
								.object({
									ok: z.literal(true),
								})
								.openapi("HealthResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			// Quick sanity check that the binding exists.
			await c.env.TURRET_DB.prepare("SELECT 1").first();
			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-sessions",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				query: turretTimeRangeSchema
					.safeExtend({
						hasError: turretHasErrorSchema.optional(),
						journeyId: z.string().optional(),
						q: z.string().optional(),
						...turretListPageSchema.shape,
					})
					.openapi("TurretReplaySessionsQuery"),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "List Turret replay sessions",
					content: {
						"application/json": {
							schema: z
								.object({
									sessions: z.array(
										TurretReplaySessionSchema
									),
									limit: z.number(),
									offset: z.number(),
								})
								.openapi("TurretReplaySessionsResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { hasError, journeyId, q, from, to, limit, offset } =
				c.req.valid("query");

			const db = makeTurretDb(c.env.TURRET_DB);

			const filters: (SQL | undefined)[] = [retainedReplay()];
			const table = turretSessions;
			if (hasError) filters.push(eq(table.hasError, true));
			if (journeyId) filters.push(eq(table.journeyId, journeyId));
			if (q) {
				const pattern = `%${escapeLike(q.trim())}%`;
				filters.push(
					or(
						like(table.initialUrl, pattern),
						like(table.lastUrl, pattern)
					)
				);
			}
			if (from !== undefined)
				filters.push(gte(table.startedAt, new Date(from)));
			if (to !== undefined)
				filters.push(lt(table.startedAt, new Date(to)));

			const rows = await db.query.turretSessions.findMany({
				where: and(...filters),
				orderBy: (t, ops) => [ops.desc(t.startedAt)],
				limit,
				offset,
			});

			return c.json({ sessions: rows, limit, offset }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/dashboard",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				query: z.object({ to: turretTimeRangeSchema.shape.to }),
			},
			responses: {
				200: {
					description: "Turret dashboard stats",
					content: {
						"application/json": {
							schema: z
								.object({
									usersWithRetainedReplays24h: z.number(),
									newUsers24h: z.number(),
									totalUsersNow: z.number(),
									totalUsersPrevWeek: z.number(),
									totalUsersDeltaPct: z.number().nullable(),
									seriesTotalUsersWeekly:
										z.array(WeeklyPointSchema),
									seriesNewUsersWeekly:
										z.array(WeeklyPointSchema),
									seriesNewUserRetentionWeeklyPct: z.array(
										z.object({
											weekStartMs: z.number(),
											value: z.number().nullable(),
										})
									),
									newUsersDeltaPctWoW: z.number().nullable(),
									retentionDeltaPctWoW: z.number().nullable(),
								})
								.openapi("TurretDashboardResponse"),
						},
					},
				},
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const env = c.env;
			const { to: toRaw } = c.req.valid("query");
			const nowMs = toRaw ?? Date.now();
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

			// This measures available replay evidence, not complete user activity.
			const [replayUsers] = await makeTurretDb(env.TURRET_DB)
				.select({ count: countDistinct(turretSessions.userId) })
				.from(turretSessions)
				.where(
					and(
						retainedReplay(),
						gte(turretSessions.startedAt, new Date(nowMs - DAY_MS)),
						lt(turretSessions.startedAt, new Date(nowMs))
					)
				);
			const usersWithRetainedReplays24h = replayUsers.count;

			// 8 completed weeks ending at currentWeekStart (start of this week).
			const weekEnds: number[] = [];
			for (let i = 8; i >= 0; i--)
				weekEnds.push(currentWeekStart - i * WEEK_MS);
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
			const totalUsersPrevWeek =
				totalsBefore[totalsBefore.length - 1] ?? 0;
			const totalUsersDeltaPct = pctDelta(
				totalUsersNow,
				totalUsersPrevWeek
			);

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
				seriesNewUsersWeekly[seriesNewUsersWeekly.length - 1]?.value ??
					0,
				seriesNewUsersWeekly[seriesNewUsersWeekly.length - 2]?.value ??
					0
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
			const cohortSizes = cohortCounts.map((r) =>
				Number(r.results?.[0]?.c ?? 0)
			);

			const retainedCounts = await env.TURRET_DB.batch<{ c: number }>(
				cohortStarts.map((start) =>
					env.TURRET_DB.prepare(
						"SELECT COUNT(DISTINCT p.user_id) AS c FROM turret_user_profile p JOIN turret_user_activity_weekly a ON a.user_id = p.user_id AND a.week_start_ms = ? WHERE p.signed_up_week_start_ms = ?"
					).bind(start + WEEK_MS, start)
				)
			);
			const retained = retainedCounts.map((r) =>
				Number(r.results?.[0]?.c ?? 0)
			);

			const seriesNewUserRetentionWeeklyPct = cohortStarts.map(
				(start, idx) => {
					const denom = cohortSizes[idx] ?? 0;
					const num = retained[idx] ?? 0;
					const value = denom === 0 ? null : (num / denom) * 100;
					return { weekStartMs: start, value };
				}
			);
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
					usersWithRetainedReplays24h,
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
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/meta",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
			},
			responses: {
				200: {
					description: "Get Turret replay session metadata",
					content: {
						"application/json": {
							schema: z
								.object({
									session: TurretReplaySessionSchema,
								})
								.openapi("TurretReplaySessionMetaResponse"),
						},
					},
				},
				...replayErrorResponses,
			},
		}),
		async (c) => {
			const { id: sessionId } = c.req.valid("param");
			const row = await readRetainedReplay(
				makeTurretDb(c.env.TURRET_DB),
				sessionId
			);
			if (!row) return c.json({ error: "Not Found" }, 404);
			return c.json({ session: row }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/chunks",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
			},
			responses: {
				200: {
					description: "List replay chunks for a replay session",
					content: {
						"application/json": {
							schema: z
								.object({
									chunks: z.array(
										z.object({
											sessionId: z.string(),
											seq: turretReplayChunkSchema.shape
												.seq,
											r2Key: z.string(),
											size: z.number(),
											sha256: z.string().nullable(),
											createdAt: z.string(),
										})
									),
								})
								.openapi("TurretChunksResponse"),
						},
					},
				},
				...replayErrorResponses,
			},
		}),
		async (c) => {
			const { id: sessionId } = c.req.valid("param");
			const db = makeTurretDb(c.env.TURRET_DB);
			if (!(await readRetainedReplay(db, sessionId)))
				return c.json({ error: "Not Found" }, 404);
			const rows = await db.query.turretSessionChunks.findMany({
				where: (t, ops) => ops.eq(t.sessionId, sessionId),
			});
			return c.json({ chunks: rows }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/errors",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
			},
			responses: {
				200: {
					description: "List errors for a replay session",
					content: {
						"application/json": {
							schema: z
								.object({
									errors: z.array(
										z.object({
											id: z.string(),
											sessionId: z.string().nullable(),
											ts: z.string(),
											source: z.string(),
											message: z.string().nullable(),
											stack: z.string().nullable(),
											fingerprint: z.string().nullable(),
											extraJson: z.string().nullable(),
											expiresAt: z.string().nullable(),
											createdAt: z.string(),
										})
									),
								})
								.openapi("TurretErrorsResponse"),
						},
					},
				},
				...replayErrorResponses,
			},
		}),
		async (c) => {
			const { id: sessionId } = c.req.valid("param");
			const db = makeTurretDb(c.env.TURRET_DB);
			if (!(await readRetainedReplay(db, sessionId)))
				return c.json({ error: "Not Found" }, 404);
			const rows = await db.query.turretSessionErrors.findMany({
				where: (t, ops) => ops.eq(t.sessionId, sessionId),
				orderBy: (t, ops) => [ops.asc(t.ts)],
			});
			return c.json({ errors: rows }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/breadcrumbs",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				query: z.object({
					...turretBreadcrumbPageSchema.shape,
				}),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description:
						"List request breadcrumbs for a replay session",
					content: {
						"application/json": {
							schema: z
								.object({
									breadcrumbs: z.array(
										z.object({
											id: z.string(),
											requestId: z.string(),
											sessionId: z.string().nullable(),
											ts: z.string(),
											method: z.string(),
											path: z.string(),
											status: z.number(),
											durationMs: z.number(),
											rayId: z.string().nullable(),
											colo: z.string().nullable(),
											d1QueriesCount: z.number(),
											d1QueriesTimeMs: z.number(),
											d1RowsRead: z.number(),
											d1RowsWritten: z.number(),
											d1ErrorsCount: z.number(),
											errorKind: z.string().nullable(),
											errorMessage: z.string().nullable(),
											extraJson: z.string().nullable(),
											expiresAt: z.string(),
											createdAt: z.string(),
										})
									),
									limit: z.number().optional(),
									offset: z.number().optional(),
								})
								.openapi("TurretBreadcrumbsResponse"),
						},
					},
				},
				...replayErrorResponses,
			},
		}),
		async (c) => {
			const { id: sessionId } = c.req.valid("param");
			const { limit, offset } = c.req.valid("query");
			const db = makeTurretDb(c.env.TURRET_DB);
			if (!(await readRetainedReplay(db, sessionId)))
				return c.json({ error: "Not Found" }, 404);
			const rows = await db.query.turretRequestBreadcrumbs.findMany({
				where: (t, ops) => ops.eq(t.sessionId, sessionId),
				orderBy: (t, ops) => [ops.asc(t.ts)],
				limit,
				offset,
			});
			return c.json({ breadcrumbs: rows, limit, offset }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/spans",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				query: z.object({
					...turretSpanPageSchema.shape,
				}),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description:
						"List spans for all requests in a replay session",
					content: {
						"application/json": {
							schema: turretReplaySessionSpansGroupedResponseSchema,
						},
					},
				},
				...replayErrorResponses,
				500: {
					description: "Internal Server Error",
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
			const { id: sessionId } = c.req.valid("param");
			const { limit, offset } = c.req.valid("query");
			if (
				!(await readRetainedReplay(
					makeTurretDb(env.TURRET_DB),
					sessionId
				))
			)
				return c.json({ error: "Not Found" }, 404);
			const spansResult = await loadReplaySessionSpansGrouped({
				db: makeTurretDb(env.TURRET_DB),
				sessionId,
				limit,
				offset,
			});

			return c.json(
				{
					spansByRequestId: spansResult.spansByRequestId,
					limit,
					offset,
					hasMore: spansResult.hasMore,
				},
				200
			);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/request/{requestId}/spans",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					requestId: z.string().openapi({ example: "<request-id>" }),
				}),
			},
			responses: {
				200: {
					description: "List spans for a request",
					content: {
						"application/json": {
							schema: z
								.object({
									spans: z.array(turretRequestSpanSchema),
								})
								.openapi("TurretSpansResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { requestId } = c.req.valid("param");
			const db = makeTurretDb(c.env.TURRET_DB);
			const rows = await db.query.turretRequestSpans.findMany({
				where: (t, ops) => ops.eq(t.requestId, requestId),
				orderBy: (t, ops) => [ops.asc(t.createdAt)],
			});
			return c.json({ spans: rows }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/chunk/{seq}",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
					seq: z
						.string()
						.regex(/^\d+$/, "Use a nonnegative integer sequence.")
						.transform(Number)
						.pipe(turretReplayChunkSchema.shape.seq)
						.openapi({ example: "0" }),
				}),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "Get a specific chunk JSON",
					content: {
						"application/json": { schema: turretReplayChunkSchema },
					},
				},
				default: {
					description: "Chunk response",
				},
				...replayErrorResponses,
			},
		}),
		async (ctx) => {
			const { id: sessionId, seq } = ctx.req.valid("param");
			const db = makeTurretDb(ctx.env.TURRET_DB);
			if (!(await readRetainedReplay(db, sessionId)))
				return ctx.json({ error: "Not Found" }, 404);

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
			}) as Response &
				TypedResponse<
					JSONParsed<z.infer<typeof turretReplayChunkSchema>>,
					200,
					"json"
				>;
		}
	);
