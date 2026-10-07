import { turretHasErrorSchema } from "../../../../contracts/turret";
import { z } from "zod";
import { timeRangeSearchSchema } from "../timeRange";
import {
	turretListPageSchema,
	turretListPageDefaults,
} from "../../../../contracts/turret-pagination";

export const replayPresetSchema = z.enum(["15m", "1h", "24h", "custom"]);
export type RangePreset = z.infer<typeof replayPresetSchema>;
const groupBySchema = z.enum(["none", "user"]);
export type GroupBy = z.infer<typeof groupBySchema>;

export const replaySearchSchema = timeRangeSearchSchema
	.extend({
		q: z.string().default("").catch(""),
		hasError: turretHasErrorSchema.default(false).catch(false),
		preset: replayPresetSchema.default("1h").catch("1h"),
		groupBy: groupBySchema.optional().catch(undefined),
		// Preserve old grouped links at the URL boundary; current navigation uses groupBy.
		grouped: z.unknown().optional(),
		offset: turretListPageSchema.shape.offset.catch(
			turretListPageDefaults.offset
		),
		limit: turretListPageSchema.shape.limit.catch(
			turretListPageDefaults.limit
		),
	})
	.transform(({ grouped, groupBy, ...search }) => ({
		...search,
		groupBy:
			groupBy ??
			(grouped === true || grouped === "true" || grouped === "1"
				? "user"
				: "none"),
	}));

// A replay link may open playback at an epoch-millisecond moment.
export const replaySessionSearchSchema = z.object({
	t: z.coerce.number().int().nonnegative().optional().catch(undefined),
});
