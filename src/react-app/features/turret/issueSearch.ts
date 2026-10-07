import { z } from "zod";
import { timeRangeSearchSchema } from "./timeRange";
import { turretIssueStatusSchema } from "../../../contracts/turret";
import {
	turretListPageSchema,
	turretListPageDefaults,
} from "../../../contracts/turret-pagination";
import { turretTrendQuerySchema } from "../../../contracts/turret-time-range";

export const issueStatusLabels = {
	open: "Open",
	resolved: "Resolved",
	ignored: "Ignored",
} satisfies Record<z.infer<typeof turretIssueStatusSchema>, string>;

export const issuePresetSchema = z.enum(["24h", "7d", "30d", "custom"]);
export type IssueRangePreset = z.infer<typeof issuePresetSchema>;
export function bucketForIssuePreset(preset: IssueRangePreset) {
	return preset === "24h" ? "hour" : "day";
}
export const issuesSearchSchema = timeRangeSearchSchema.extend({
	status: turretIssueStatusSchema.default("open").catch("open"),
	preset: issuePresetSchema.default("24h").catch("24h"),
	q: z.string().default("").catch(""),
	offset: turretListPageSchema.shape.offset.catch(
		turretListPageDefaults.offset
	),
	limit: turretListPageSchema.shape.limit.catch(turretListPageDefaults.limit),
});
export const issueDetailSearchSchema = timeRangeSearchSchema
	.extend({
		preset: issuePresetSchema.default("7d").catch("7d"),
		bucket: turretTrendQuerySchema.shape.bucket
			.removeDefault()
			.optional()
			.catch(undefined),
		eventsOffset: turretListPageSchema.shape.offset.catch(
			turretListPageDefaults.offset
		),
		eventsLimit: turretListPageSchema.shape.limit.catch(
			turretListPageDefaults.limit
		),
	})
	.transform(({ bucket, ...search }) => ({
		...search,
		bucket: bucket ?? bucketForIssuePreset(search.preset),
	}));
