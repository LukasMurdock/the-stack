import { literalContains } from "../../../bindings/d1/literal-search";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import {
	turretIssueFeedback,
	turretUserFeedback,
} from "../../../bindings/d1/turret/schema";
import {
	linkFeedbackToIssue,
	reportIssueFingerprint,
} from "../../turret/issues";
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
		// The issue this report is evidence for, if any.
		issueFingerprint: z.string().nullable(),
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
	issueFingerprint: sql<string | null>`(
		SELECT ${turretIssueFeedback.fingerprint} FROM ${turretIssueFeedback}
		WHERE ${turretIssueFeedback.feedbackId} = ${turretUserFeedback.id}
	)`,
	createdAt: sql<number>`${turretUserFeedback.createdAt}`,
	updatedAt: sql<number>`${turretUserFeedback.updatedAt}`,
} satisfies Record<keyof z.infer<typeof FeedbackItemSchema>, unknown>;

// Bounds the reports listed on one issue page; links beyond it still count.
const ISSUE_REPORTS_MAX = 200;

const FeedbackIssueLinkResponseSchema = z
	.object({ issueFingerprint: z.string() })
	.openapi("TurretFeedbackIssueLink");

const feedbackNotFound = {
	404: {
		description: "Feedback or issue not found",
		content: {
			"application/json": { schema: adminErrorResponseSchema },
		},
	},
};

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
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/internal/turret/feedback/{id}/issue",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<feedback-id>" }),
				}),
			},
			responses: {
				200: {
					description:
						"Promote a report to its own tracked issue, moving it from any other issue",
					content: {
						"application/json": {
							schema: FeedbackIssueLinkResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				...feedbackNotFound,
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const fingerprint = reportIssueFingerprint(id);
			const linked = await linkFeedbackToIssue(
				makeTurretDb(c.env.TURRET_DB),
				{ feedbackId: id, fingerprint, promote: true, now: Date.now() }
			);
			if (!linked) return c.json({ error: "Not Found" }, 404);
			return c.json({ issueFingerprint: fingerprint }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "put",
			path: "/internal/turret/feedback/{id}/issue",
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
								.object({ issueFingerprint: z.string().min(1) })
								.openapi("TurretFeedbackIssueLinkUpdate"),
						},
					},
				},
			},
			responses: {
				200: {
					description:
						"Link a report to an existing issue, moving it from any other issue",
					content: {
						"application/json": {
							schema: FeedbackIssueLinkResponseSchema,
						},
					},
				},
				...adminErrorResponses,
				...feedbackNotFound,
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			const { issueFingerprint } = c.req.valid("json");
			const linked = await linkFeedbackToIssue(
				makeTurretDb(c.env.TURRET_DB),
				{
					feedbackId: id,
					fingerprint: issueFingerprint,
					promote: false,
					now: Date.now(),
				}
			);
			if (!linked) return c.json({ error: "Not Found" }, 404);
			return c.json({ issueFingerprint }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "delete",
			path: "/internal/turret/feedback/{id}/issue",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<feedback-id>" }),
				}),
			},
			responses: {
				200: {
					description:
						"Unlink a report from its issue. An issue left without evidence no longer appears.",
					content: {
						"application/json": {
							schema: z
								.object({ ok: z.literal(true) })
								.openapi("TurretFeedbackIssueUnlink"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { id } = c.req.valid("param");
			await makeTurretDb(c.env.TURRET_DB)
				.delete(turretIssueFeedback)
				.where(eq(turretIssueFeedback.feedbackId, id));
			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/reports",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ fingerprint: z.string() }),
			},
			responses: {
				200: {
					description: "List feedback reports linked to an issue",
					content: {
						"application/json": {
							schema: z
								.object({
									reports: z.array(
										FeedbackItemSchema.extend({
											replayAvailable: z.boolean(),
										})
									),
								})
								.openapi("TurretIssueReportsResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { fingerprint } = c.req.valid("param");
			const now = Date.now();
			const rows = await makeTurretDb(c.env.TURRET_DB)
				.select({
					...feedbackProjection,
					replayAvailable: sql<number>`EXISTS (
						SELECT 1 FROM turret_sessions s
						WHERE s.session_id = ${turretUserFeedback.sessionId}
							AND s.chunk_count > 0 AND s.retention_expires_at > ${now}
					)`,
				})
				.from(turretUserFeedback)
				.innerJoin(
					turretIssueFeedback,
					eq(turretIssueFeedback.feedbackId, turretUserFeedback.id)
				)
				.where(eq(turretIssueFeedback.fingerprint, fingerprint))
				.orderBy(
					desc(turretUserFeedback.ts),
					desc(turretUserFeedback.id)
				)
				.limit(ISSUE_REPORTS_MAX);
			const reports = rows.map(({ replayAvailable, ...report }) => ({
				...FeedbackItemSchema.parse(report),
				replayAvailable: Boolean(replayAvailable),
			}));
			return c.json({ reports }, 200);
		}
	);
