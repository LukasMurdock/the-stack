import { z } from "zod";
import { timeRangeSearchSchema } from "./timeRange";
import {
	turretIssuePrioritySchema,
	turretIssueSortSchema,
	turretIssueStatusSchema,
	turretIssueViewSchema,
} from "../../../contracts/turret";
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
export const issueViewLabels = {
	open: "Open",
	new: "New",
	escalating: "Escalating",
	regressed: "Regressed",
	resolved: "Resolved",
	ignored: "Ignored",
} satisfies Record<z.infer<typeof turretIssueViewSchema>, string>;
export const issueAssigneeFilterLabels = {
	anyone: "Anyone",
	me: "Assigned to me",
	none: "Unassigned",
} as const;
export const issueSortLabels = {
	lastSeen: "Last seen",
	users: "Users affected",
	occurrences: "Occurrences",
	priority: "Priority",
} satisfies Record<z.infer<typeof turretIssueSortSchema>, string>;
export const issuePriorityLabels = {
	high: "High",
	medium: "Medium",
	low: "Low",
} satisfies Record<z.infer<typeof turretIssuePrioritySchema>, string>;

// Describes window occurrences relative to the preceding equal-length window.
export function formatOccurrenceChange(current: number, previous: number) {
	if (previous === 0) return current === 0 ? "none" : "none before";
	const change = Math.round(((current - previous) / previous) * 100);
	if (change === 0) return "no change";
	return `${change > 0 ? "+" : "−"}${Math.abs(change)}%`;
}

export const issuePresetSchema = z.enum(["24h", "7d", "30d", "custom"]);
export type IssueRangePreset = z.infer<typeof issuePresetSchema>;
export function bucketForIssuePreset(preset: IssueRangePreset) {
	return preset === "24h" ? "hour" : "day";
}
export const issuesSearchSchema = timeRangeSearchSchema.extend({
	status: turretIssueViewSchema.default("open").catch("open"),
	sort: turretIssueSortSchema.default("lastSeen").catch("lastSeen"),
	// Narrows the inbox to the current administrator's or unowned issues.
	assignee: z.enum(["me", "none"]).optional().catch(undefined),
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
		// The occurrence under investigation; defaults to the representative one.
		event: z.string().min(1).optional().catch(undefined),
		// A linked report under investigation instead of an occurrence.
		report: z.string().min(1).optional().catch(undefined),
		// Replay position in epoch milliseconds, kept so a link reopens the moment.
		t: z.coerce.number().int().nonnegative().optional().catch(undefined),
	})
	.transform(({ bucket, ...search }) => ({
		...search,
		bucket: bucket ?? bucketForIssuePreset(search.preset),
	}));
