import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";

type D1Database = globalThis.D1Database;

const internalTurretFeedbackApp = new OpenAPIHono();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const FeedbackStatusSchema = z
	.enum(["open", "triaged", "resolved"])
	.openapi("TurretFeedbackStatus");

const FeedbackKindSchema = z
	.enum(["bug", "idea", "praise", "other"])
	.openapi("TurretFeedbackKind");

const FeedbackItemSchema = z
	.object({
		id: z.string(),
		sessionId: z.string(),
		userId: z.string(),
		userEmail: z.string().nullable(),
		ts: z.number(),
		url: z.string().nullable(),
		kind: FeedbackKindSchema,
		message: z.string(),
		contact: z.string().nullable(),
		status: FeedbackStatusSchema,
		createdAt: z.number(),
		updatedAt: z.number(),
	})
	.openapi("TurretFeedbackItem");

const FeedbackListResponseSchema = z
	.object({
		feedback: z.array(FeedbackItemSchema),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretFeedbackListResponse");

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretFeedbackApp.use("/internal/turret/*", async (c, next) => {
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

const listFeedback = createRoute({
	method: "get",
	path: "/internal/turret/feedback",
	request: {
		query: z
			.object({
				status: FeedbackStatusSchema.optional(),
				kind: FeedbackKindSchema.optional(),
				q: z.string().optional(),
				from: z.string().optional(),
				to: z.string().optional(),
				limit: z.string().optional(),
				offset: z.string().optional(),
				sessionId: z.string().optional(),
				userId: z.string().optional(),
			})
			.openapi("TurretFeedbackQuery"),
	},
	responses: {
		200: {
			description: "List user feedback",
			content: {
				"application/json": { schema: FeedbackListResponseSchema },
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

internalTurretFeedbackApp.openapi(listFeedback, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const qv = c.req.valid("query");
	const now = Date.now();
	const fromMs = parseMs(qv.from) ?? now - 30 * 24 * 60 * 60 * 1000;
	const toMs = parseMs(qv.to) ?? now;
	const status = qv.status;
	const kind = qv.kind;
	const sessionId = qv.sessionId;
	const userId = qv.userId;
	const limit = Math.max(1, Math.min(200, Number(qv.limit ?? "50") || 50));
	const offset = Math.max(0, Number(qv.offset ?? "0") || 0);
	const q = (qv.q ?? "").trim();
	const like = q ? `%${escapeLike(q)}%` : "";

	let sqlText = `
		SELECT
			id,
			session_id AS sessionId,
			user_id AS userId,
			user_email AS userEmail,
			ts,
			url,
			kind,
			message,
			contact,
			status,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM turret_user_feedback
		WHERE ts >= ? AND ts < ?
	`;
	const params: unknown[] = [fromMs, toMs];

	if (status) {
		sqlText += " AND status = ?";
		params.push(status);
	}
	if (kind) {
		sqlText += " AND kind = ?";
		params.push(kind);
	}
	if (sessionId) {
		sqlText += " AND session_id = ?";
		params.push(sessionId);
	}
	if (userId) {
		sqlText += " AND user_id = ?";
		params.push(userId);
	}
	if (q) {
		sqlText +=
			" AND (message LIKE ? ESCAPE '\\' OR COALESCE(url,'') LIKE ? ESCAPE '\\')";
		params.push(like, like);
	}

	sqlText += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
	params.push(limit, offset);

	const res = await env.TURRET_DB.prepare(sqlText)
		.bind(...params)
		.all();
	const rows = (res.results ?? []) as unknown as z.infer<
		typeof FeedbackItemSchema
	>[];

	return c.json(
		{
			feedback: rows,
			limit,
			offset,
		},
		200
	);
});

const listSessionFeedback = createRoute({
	method: "get",
	path: "/internal/turret/session/{id}/feedback",
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
			description: "List feedback for a session",
			content: {
				"application/json": { schema: FeedbackListResponseSchema },
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

internalTurretFeedbackApp.openapi(listSessionFeedback, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { id: sessionId } = c.req.valid("param");
	const { limit: limitRaw, offset: offsetRaw } = c.req.valid("query");
	const limit = Math.max(1, Math.min(200, Number(limitRaw ?? "50") || 50));
	const offset = Math.max(0, Number(offsetRaw ?? "0") || 0);

	const sqlText = `
		SELECT
			id,
			session_id AS sessionId,
			user_id AS userId,
			user_email AS userEmail,
			ts,
			url,
			kind,
			message,
			contact,
			status,
			created_at AS createdAt,
			updated_at AS updatedAt
		FROM turret_user_feedback
		WHERE session_id = ?
		ORDER BY ts DESC
		LIMIT ? OFFSET ?
	`;

	const res = await env.TURRET_DB.prepare(sqlText)
		.bind(sessionId, limit, offset)
		.all();
	return c.json(
		{
			feedback: (res.results ?? []) as unknown as z.infer<
				typeof FeedbackItemSchema
			>[],
			limit,
			offset,
		},
		200
	);
});

const patchFeedback = createRoute({
	method: "patch",
	path: "/internal/turret/feedback/{id}",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<feedback-id>" }),
		}),
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z
						.object({ status: FeedbackStatusSchema })
						.openapi("TurretFeedbackPatch"),
				},
			},
		},
	},
	responses: {
		200: {
			description: "Update feedback status",
			content: {
				"application/json": {
					schema: z
						.object({ ok: z.literal(true) })
						.openapi("OkResponse"),
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
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretFeedbackApp.openapi(patchFeedback, async (c) => {
	const env = c.env as unknown as { TURRET_DB: D1Database };
	const { id } = c.req.valid("param");
	const { status } = c.req.valid("json");
	const now = Date.now();

	const result = await env.TURRET_DB.prepare(
		"UPDATE turret_user_feedback SET status = ?, updated_at = ? WHERE id = ?"
	)
		.bind(status, now, id)
		.run();

	if (!result.success || (result.meta?.changes ?? 0) === 0) {
		return c.json({ error: "Not Found" }, 404);
	}

	return c.json({ ok: true as const }, 200);
});

export { internalTurretFeedbackApp };
export const routes = internalTurretFeedbackApp;
