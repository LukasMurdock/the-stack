import { z } from "zod";
export const turretRangeDurations = {
	"15m": 15 * 60_000,
	"1h": 60 * 60_000,
	"24h": 24 * 60 * 60_000,
	"7d": 7 * 24 * 60 * 60_000,
	"30d": 30 * 24 * 60 * 60_000,
};
export const turretTimestampMsSchema = z
	.union([z.number(), z.string().regex(/^\d+$/, "Use epoch milliseconds.")])
	.pipe(
		z.coerce
			.number<string | number>()
			.int()
			.min(0)
			.max(8_640_000_000_000_000)
	);
// All ranges include from and exclude to. Missing endpoints are resolved by the endpoint's default window.
export const turretTimeRangeSchema = z
	.object({
		from: turretTimestampMsSchema.optional(),
		to: turretTimestampMsSchema.optional(),
	})
	.refine(
		({ from, to }) => from === undefined || to === undefined || from < to,
		{ path: ["to"], error: "End must be later than start." }
	);
export const turretTrendBucketSchema = z.enum(["hour", "day"]);
export const turretTrendBuckets = {
	hour: turretRangeDurations["1h"],
	day: turretRangeDurations["24h"],
} satisfies Record<z.infer<typeof turretTrendBucketSchema>, number>;
export const TURRET_TREND_POINTS_MAX = 1000;
export const turretTrendQuerySchema = turretTimeRangeSchema
	.safeExtend({ bucket: turretTrendBucketSchema.default("day") })
	.superRefine(({ from, to, bucket }, context) => {
		if (from === undefined || to === undefined) return;
		const step = turretTrendBuckets[bucket];
		if (
			Math.ceil(to / step) - Math.floor(from / step) >
			TURRET_TREND_POINTS_MAX
		)
			context.addIssue({
				code: "custom",
				path: ["from"],
				message: `Use a range with ${TURRET_TREND_POINTS_MAX} buckets or fewer.`,
			});
	});
export function resolveTurretTimeRange(
	input: z.output<typeof turretTimeRangeSchema>,
	now: number,
	lookbackMs: number
) {
	const to = input.to ?? now;
	return { from: input.from ?? Math.max(0, to - lookbackMs), to };
}
