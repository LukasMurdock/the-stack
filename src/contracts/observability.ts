import { z } from "zod";

const replayTotalsSchema = z.object({
	replaySessions: z.number().int().nonnegative(),
	errorReplaySessions: z.number().int().nonnegative(),
	captureBlocked: z.number().int().nonnegative(),
});
const operationTotalsSchema = z.object({
	requests: z.number().nonnegative(),
	serverErrors: z.number().nonnegative(),
	slowRequests: z.number().nonnegative(),
	avgDurationMs: z.number().nonnegative().nullable(),
	p95DurationMs: z.number().nonnegative().nullable(),
});
const operationRouteSchema = operationTotalsSchema.extend({
	surface: z.string(),
	method: z.string(),
	route: z.string(),
	category: z.string(),
	version: z.string(),
});
export const turretSummarySchema = z.object({
	from: z.number(),
	to: z.number(),
	replay: z.discriminatedUnion("state", [
		z.object({ state: z.literal("ready"), totals: replayTotalsSchema }),
		z.object({ state: z.literal("unavailable") }),
	]),
	operations: z.discriminatedUnion("state", [
		z.object({
			state: z.literal("ready"),
			totals: operationTotalsSchema,
			routes: z.array(operationRouteSchema),
		}),
		z.object({
			state: z.literal("unavailable"),
			reason: z.enum([
				"not_configured",
				"local_environment",
				"query_failed",
			]),
		}),
	]),
});
export type TurretSummary = z.infer<typeof turretSummarySchema>;
