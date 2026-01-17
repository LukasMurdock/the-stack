import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import { createAuth, type AuthEnv } from "../../auth";

type D1Database = globalThis.D1Database;


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
			content: { "application/json": { schema: BreadcrumbsResponseSchema } },
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
			content: { "application/json": { schema: SessionMetaResponseSchema } },
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
	await (c.env as { TURRET_DB: D1Database }).TURRET_DB.prepare("SELECT 1").first();
	return c.json({ ok: true as const }, 200);
});

internalTurretApp.openapi(getSessions, async (c) => {
	const { hasError, q, from, to, limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
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
		initialUrl: unknown;
		lastUrl: unknown;
		startedAt: unknown;
	};

	const filters: Array<(t: TurretSessionRow, ops: Ops) => unknown> = [];

	if (hasError === "1") filters.push((t, ops) => ops.eq(t.hasError, true));
	if (q) {
		const qEsc = escapeLike(q.trim());
		filters.push((t, ops) => ops.or(ops.like(t.initialUrl, `%${qEsc}%`), ops.like(t.lastUrl, `%${qEsc}%`)));
	}
	if (from) {
		const fromMs = Number(from);
		if (!Number.isNaN(fromMs)) filters.push((t, ops) => ops.gte(t.startedAt, new Date(fromMs)));
	}
	if (to) {
		const toMs = Number(to);
		if (!Number.isNaN(toMs)) filters.push((t, ops) => ops.lte(t.startedAt, new Date(toMs)));
	}

	const rows = await db.query.turretSessions.findMany({
		where: filters.length
			? (((t: any, ops: any) => {
				return ops.and(...filters.map((fn) => fn(t, ops)));
			}) as unknown as never)
			: undefined,
		orderBy: (((t: any, ops: any) => [ops.desc(t.startedAt)]) as unknown as never),
		limit,
		offset,
	});

	return c.json({ sessions: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getSessionMeta, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const row = await db.query.turretSessions.findFirst({
		where: ((t: any, ops: any) => ops.eq(t.sessionId, sessionId)) as unknown as never,
	});
	if (!row) return c.json({ error: "Not Found" }, 404);
	return c.json({ session: row }, 200);
});

internalTurretApp.openapi(getChunks, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretSessionChunks.findMany({
		where: ((t: any, ops: any) => ops.eq(t.sessionId, sessionId)) as unknown as never,
	});
	return c.json({ chunks: rows }, 200);
});

internalTurretApp.openapi(getSessionErrors, async (c) => {
	const { id: sessionId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretSessionErrors.findMany({
		where: ((t: any, ops: any) => ops.eq(t.sessionId, sessionId)) as unknown as never,
		orderBy: (((t: any, ops: any) => [ops.asc(t.ts)]) as unknown as never),
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
		where: ((t: any, ops: any) => ops.eq(t.sessionId, sessionId)) as unknown as never,
		orderBy: (((t: any, ops: any) => [ops.asc(t.ts)]) as unknown as never),
		limit,
		offset,
	});
	return c.json({ breadcrumbs: rows, limit, offset }, 200);
});

internalTurretApp.openapi(getRequestSpans, async (c) => {
	const { requestId } = c.req.valid("param");
	const db = makeTurretDb((c.env as { TURRET_DB: D1Database }).TURRET_DB);
	const rows = await db.query.turretRequestSpans.findMany({
		where: ((t: any, ops: any) => ops.eq(t.requestId, requestId)) as unknown as never,
		orderBy: (((t: any, ops: any) => [ops.asc(t.createdAt)]) as unknown as never),
	});
	return c.json({ spans: rows }, 200);
});

internalTurretApp.openapi(getChunk, (async (c: unknown) => {
	const ctx = c as any;
	const { id: sessionId, seq: seqRaw } = ctx.req.valid("param");
	const seq = Number(seqRaw);
	const db = makeTurretDb((ctx.env as { TURRET_DB: D1Database }).TURRET_DB);

	const chunk = await db.query.turretSessionChunks.findFirst({
		where: ((t: any, ops: any) => ops.and(ops.eq(t.sessionId, sessionId), ops.eq(t.seq, seq))) as unknown as never,
	});
	if (!chunk) return ctx.json({ error: "Not Found" }, 404);

	const obj = await (
		ctx.env as {
			TURRET_REPLAY_BUCKET: {
				get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
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
