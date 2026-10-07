import { sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import { productErrors } from "../../../contracts/operation";
import { turretListPageSchema } from "../../../contracts/turret-pagination";
import {
	TURRET_OUTCOME_IDLE_MS,
	turretOutcomeStatusSchema,
	turretWorkflowSchema,
} from "../../../contracts/turret-outcomes";
import {
	resolveTurretTimeRange,
	turretRangeDurations,
	turretTimeRangeSchema,
} from "../../../contracts/turret-time-range";
import { commandInput } from "../../../features/shared/context";
import type { Bindings } from "../../index";
import {
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";
import {
	errorResponses,
	operationErrorHandler,
	validationHook,
} from "./_shared/operation-http";

const app = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
app.onError(operationErrorHandler);

const invalidInput = {
	[productErrors.invalid_input.status]:
		errorResponses[productErrors.invalid_input.status],
};
const REASONS_MAX = 5;

function resolveWindow(input: { from?: number; to?: number }, now: number) {
	return commandInput(
		turretTimeRangeSchema.required(),
		resolveTurretTimeRange(input, now, turretRangeDurations["7d"])
	);
}

// An attempt's status at `now`; see TURRET_OUTCOME_IDLE_MS.
function attemptStatus(now: number) {
	return sql`CASE
		WHEN a.succeeded_at IS NOT NULL THEN 'succeeded'
		WHEN a.last_event_at < ${now - TURRET_OUTCOME_IDLE_MS}
			THEN CASE WHEN a.failures > 0 THEN 'failed' ELSE 'abandoned' END
		ELSE 'in_progress'
	END`;
}

const WorkflowSummarySchema = z
	.object({
		workflow: turretWorkflowSchema,
		attempts: z.number(),
		succeeded: z.number(),
		// Succeeded only after at least one failure: completed, with friction.
		succeededAfterFailure: z.number(),
		failed: z.number(),
		abandoned: z.number(),
		inProgress: z.number(),
		// Last failure reasons among attempts that failed at least once.
		reasons: z.array(
			z.object({ reason: z.string(), attempts: z.number() })
		),
	})
	.openapi("TurretWorkflowSummary");

const AttemptSchema = z
	.object({
		id: z.string(),
		sessionId: z.string(),
		userId: z.string(),
		userEmail: z.string().nullable(),
		status: turretOutcomeStatusSchema,
		startedAt: z.number(),
		lastEventAt: z.number(),
		succeededAt: z.number().nullable(),
		failures: z.number(),
		lastFailureAt: z.number().nullable(),
		lastFailureReason: z.string().nullable(),
		replayAvailable: z.boolean(),
	})
	.openapi("TurretWorkflowAttempt");

export const routes = app
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/outcomes",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				query: turretTimeRangeSchema,
			},
			responses: {
				200: {
					description:
						"Workflow attempts started in a time range, by outcome",
					content: {
						"application/json": {
							schema: z
								.object({
									workflows: z.array(WorkflowSummarySchema),
									idleMs: z.number(),
								})
								.openapi("TurretOutcomesResponse"),
						},
					},
				},
				...invalidInput,
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const now = Date.now();
			const { from, to } = resolveWindow(c.req.valid("query"), now);
			const db = makeTurretDb(c.env.TURRET_DB);
			const status = attemptStatus(now);
			const [counts, reasons] = await Promise.all([
				db.all<Record<string, number | string>>(sql`
					SELECT a.workflow AS workflow,
						COUNT(*) AS attempts,
						SUM(${status} = 'succeeded') AS succeeded,
						SUM(${status} = 'succeeded' AND a.failures > 0) AS succeededAfterFailure,
						SUM(${status} = 'failed') AS failed,
						SUM(${status} = 'abandoned') AS abandoned,
						SUM(${status} = 'in_progress') AS inProgress
					FROM turret_outcome_attempts a
					WHERE a.started_at >= ${from} AND a.started_at < ${to}
					GROUP BY a.workflow
				`),
				db.all<{
					workflow: string;
					reason: string;
					attempts: number;
				}>(sql`
					SELECT a.workflow AS workflow, a.last_failure_reason AS reason,
						COUNT(*) AS attempts
					FROM turret_outcome_attempts a
					WHERE a.started_at >= ${from} AND a.started_at < ${to}
						AND a.failures > 0
					GROUP BY a.workflow, a.last_failure_reason
					ORDER BY attempts DESC, reason ASC
				`),
			]);
			// Every workflow appears, so an uninstrumented or idle one is visible.
			const workflows = turretWorkflowSchema.options.map((workflow) => {
				const row = counts.find((r) => r.workflow === workflow);
				const count = (key: string) => Number(row?.[key] ?? 0);
				return {
					workflow,
					attempts: count("attempts"),
					succeeded: count("succeeded"),
					succeededAfterFailure: count("succeededAfterFailure"),
					failed: count("failed"),
					abandoned: count("abandoned"),
					inProgress: count("inProgress"),
					reasons: reasons
						.filter((r) => r.workflow === workflow)
						.slice(0, REASONS_MAX)
						.map(({ reason, attempts }) => ({ reason, attempts })),
				};
			});
			return c.json({ workflows, idleMs: TURRET_OUTCOME_IDLE_MS }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/outcomes/{workflow}/attempts",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: z.object({ workflow: turretWorkflowSchema }),
				query: turretTimeRangeSchema
					.safeExtend({
						status: turretOutcomeStatusSchema.optional(),
						...turretListPageSchema.shape,
					})
					.openapi("TurretWorkflowAttemptsQuery"),
			},
			responses: {
				200: {
					description:
						"Attempts at a workflow started in a time range, newest first",
					content: {
						"application/json": {
							schema: z
								.object({
									attempts: z.array(AttemptSchema),
									limit: z.number(),
									offset: z.number(),
								})
								.openapi("TurretWorkflowAttemptsResponse"),
						},
					},
				},
				...invalidInput,
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { workflow } = c.req.valid("param");
			const query = c.req.valid("query");
			const now = Date.now();
			const { from, to } = resolveWindow(query, now);
			const status = attemptStatus(now);
			const rows = await makeTurretDb(c.env.TURRET_DB).all<
				Record<string, unknown>
			>(sql`
				SELECT a.id, a.session_id AS sessionId, a.user_id AS userId,
					s.user_email AS userEmail, ${status} AS status,
					a.started_at AS startedAt, a.last_event_at AS lastEventAt,
					a.succeeded_at AS succeededAt, a.failures,
					a.last_failure_at AS lastFailureAt,
					a.last_failure_reason AS lastFailureReason,
					COALESCE(s.chunk_count > 0 AND s.retention_expires_at > ${now}, 0)
						AS replayAvailable
				FROM turret_outcome_attempts a
				LEFT JOIN turret_sessions s ON s.session_id = a.session_id
				WHERE a.workflow = ${workflow}
					AND a.started_at >= ${from} AND a.started_at < ${to}
					AND (${query.status ?? null} IS NULL OR ${status} = ${query.status ?? null})
				ORDER BY a.started_at DESC, a.id DESC
				LIMIT ${query.limit} OFFSET ${query.offset}
			`);
			const attempts = rows.map((row) =>
				AttemptSchema.parse({
					...row,
					replayAvailable: Boolean(row.replayAvailable),
				})
			);
			return c.json(
				{ attempts, limit: query.limit, offset: query.offset },
				200
			);
		}
	);
