import { literalContains } from "../../../bindings/d1/literal-search";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { turretUserFeedback } from "../../../bindings/d1/turret/schema";
import { readRetainedReplay } from "../../turret/retention";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import {
	turretTimeRangeSchema,
	resolveTurretTimeRange,
	turretRangeDurations,
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
import {
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
} from "../../../contracts/turret";
import {
	adminErrorResponseSchema,
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";

const internalTurretFeedbackApp = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
internalTurretFeedbackApp.onError(operationErrorHandler);

const FeedbackStatusSchema = turretFeedbackStatusSchema;
const FeedbackKindSchema = turretFeedbackKindSchema;

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

// Dates are deliberately milliseconds on this API. SQL expressions bypass the
// table's Date decoder; all readers share this explicit public projection.
const feedbackProjection = {
	id: turretUserFeedback.id,
	sessionId: turretUserFeedback.sessionId,
	userId: turretUserFeedback.userId,
	userEmail: turretUserFeedback.userEmail,
	ts: sql<number>`${turretUserFeedback.ts}`,
	url: turretUserFeedback.url,
	kind: turretUserFeedback.kind,
	message: turretUserFeedback.message,
	contact: turretUserFeedback.contact,
	status: turretUserFeedback.status,
	createdAt: sql<number>`${turretUserFeedback.createdAt}`,
	updatedAt: sql<number>`${turretUserFeedback.updatedAt}`,
} satisfies Record<keyof z.infer<typeof FeedbackItemSchema>, unknown>;

const FeedbackListResponseSchema = z
	.object({
		feedback: z.array(FeedbackItemSchema),
		limit: z.number(),
		offset: z.number(),
	})
	.openapi("TurretFeedbackListResponse");

internalTurretFeedbackApp.get(
	"/internal/turret/session/:id/feedback",
	requireInternalTurretAdmin,
	(c) => {
		const query = new URL(c.req.url).search;
		return c.redirect(
			`/api/internal/turret/replay-session/${c.req.param("id")}/feedback${query}`,
			308
		);
	}
);

export { internalTurretFeedbackApp };

export const routes = internalTurretFeedbackApp
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/feedback",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				query: turretTimeRangeSchema
					.safeExtend({
						status: FeedbackStatusSchema.optional(),
						kind: FeedbackKindSchema.optional(),
						q: z.string().optional(),
						...turretListPageSchema.shape,
						sessionId: z.string().optional(),
						userId: z.string().optional(),
					})
					.openapi("TurretFeedbackQuery"),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "List user feedback",
					content: {
						"application/json": {
							schema: FeedbackListResponseSchema,
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const env = c.env;
			const qv = c.req.valid("query");
			const { limit, offset } = qv;
			const now = Date.now();
			const { from: fromMs, to: toMs } = commandInput(
				turretTimeRangeSchema.required(),
				resolveTurretTimeRange(qv, now, turretRangeDurations["30d"])
			);
			const status = qv.status;
			const kind = qv.kind;
			const sessionId = qv.sessionId;
			const userId = qv.userId;
			const q = (qv.q ?? "").trim();

			const table = turretUserFeedback;
			const filters: SQL[] = [
				gte(table.ts, new Date(fromMs)),
				lt(table.ts, new Date(toMs)),
			];
			if (status) filters.push(eq(table.status, status));
			if (kind) filters.push(eq(table.kind, kind));
			if (sessionId) filters.push(eq(table.sessionId, sessionId));
			if (userId) filters.push(eq(table.userId, userId));
			if (q)
				filters.push(
					sql`(${literalContains(table.message, q)} OR ${literalContains(table.url, q)})`
				);
			const rows = FeedbackItemSchema.array().parse(
				await makeTurretDb(env.TURRET_DB)
					.select(feedbackProjection)
					.from(table)
					.where(and(...filters))
					.orderBy(desc(table.createdAt), desc(table.id))
					.limit(limit)
					.offset(offset)
			);

			return c.json(
				{
					feedback: rows,
					limit,
					offset,
				},
				200
			);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/replay-session/{id}/feedback",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				query: z.object({
					...turretListPageSchema.shape,
				}),
			},
			responses: {
				[productErrors.invalid_input.status]:
					errorResponses[productErrors.invalid_input.status],
				200: {
					description: "List feedback for a replay session",
					content: {
						"application/json": {
							schema: FeedbackListResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				404: {
					description: "Replay session not found or expired",
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
			const rows = FeedbackItemSchema.array().parse(
				await makeTurretDb(env.TURRET_DB)
					.select(feedbackProjection)
					.from(turretUserFeedback)
					.where(eq(turretUserFeedback.sessionId, sessionId))
					.orderBy(
						desc(turretUserFeedback.ts),
						desc(turretUserFeedback.id)
					)
					.limit(limit)
					.offset(offset)
			);

			return c.json(
				{
					feedback: rows,
					limit,
					offset,
				},
				200
			);
		}
	)
	.openapi(
		createRoute({
			method: "patch",
			path: "/internal/turret/feedback/{id}",
			middleware: [requireInternalTurretAdmin] as const,
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
				...adminErrorResponses,
				404: {
					description: "Not found",
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
		}
	);
