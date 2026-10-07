import { turretTimestampMsSchema } from "./turret-time-range";
import { turretComplianceSchema } from "./turret-policy";
import { z } from "zod";

// Typed navigation and serialized query strings represent the same replay filter.
export const turretHasErrorSchema = z
	.union([z.boolean(), z.enum(["1", "0", "true", "false"])])
	.transform((value) => value === true || value === "1" || value === "true");

const turretIssueStatusSchema = z.enum(["open", "resolved", "ignored"]);
// Views narrow open issues by how they changed, or list another status.
// New: first seen in the window. Escalating: occurrences in the window grew
// past the escalation rule. Regressed: reopened by an occurrence after
// resolution.
const turretIssueViewSchema = z.enum([
	"open",
	"new",
	"escalating",
	"regressed",
	"resolved",
	"ignored",
]);
const turretIssueSortSchema = z.enum([
	"lastSeen",
	"users",
	"occurrences",
	"priority",
]);
const turretIssuePrioritySchema = z.enum(["high", "medium", "low"]);
// "next_deployment" expects occurrences from the current deployment until the
// fix ships; only occurrences from other deployments reopen the issue.
const turretIssueResolveInSchema = z.enum(["now", "next_deployment"]);
// An escalating issue at least doubled versus the preceding window of equal
// length, with enough occurrences that the change is not noise.
const TURRET_ESCALATION_FACTOR = 2;
const TURRET_ESCALATION_MIN_OCCURRENCES = 10;
// Notes and changes recorded on an issue, attributed to an administrator.
const turretIssueActivityKindSchema = z.enum([
	"note",
	"status",
	"priority",
	"assignee",
	"link_added",
	"link_removed",
]);
const turretFeedbackKindSchema = z.enum(["bug", "idea", "praise", "other"]);
const turretFeedbackStatusSchema = z.enum(["open", "triaged", "resolved"]);

export const turretFeedbackBodySchema = z.object({
	ts: turretTimestampMsSchema,
	kind: turretFeedbackKindSchema,
	message: z
		.string()
		.trim()
		.min(1, "Message is required")
		.max(4000, {
			error: (issue) => `Use ${issue.maximum} characters or fewer.`,
		}),
	// Capture the current URL without rejecting feedback from a long application URL.
	url: z
		.string()
		.transform((value) => value.slice(0, 2000))
		.optional(),
	contact: z
		.string()
		.trim()
		.max(320, {
			error: (issue) =>
				`Use ${issue.maximum} characters or fewer for contact details.`,
		})
		.optional(),
	extra: z.record(z.string(), z.unknown()).optional(),
});

const turretRequestBreadcrumbSchema = z.object({
	id: z.string(),
	requestId: z.string(),
	sessionId: z.string().nullable(),
	ts: z.string(),
	method: z.string(),
	path: z.string(),
	status: z.number(),
	durationMs: z.number(),
	rayId: z.string().nullable(),
	colo: z.string().nullable(),
	d1QueriesCount: z.number(),
	d1QueriesTimeMs: z.number(),
	d1RowsRead: z.number(),
	d1RowsWritten: z.number(),
	d1ErrorsCount: z.number(),
	errorKind: z.string().nullable(),
	errorMessage: z.string().nullable(),
	extraJson: z.string().nullable(),
	expiresAt: z.string(),
	createdAt: z.string(),
});

const turretRequestSpanSchema = z.object({
	id: z.string(),
	breadcrumbId: z.string(),
	ts: z.string(),
	kind: z.string(),
	db: z.string().nullable(),
	durationMs: z.number(),
	sqlShape: z.string().nullable(),
	rowsRead: z.number().nullable(),
	rowsWritten: z.number().nullable(),
	errorMessage: z.string().nullable(),
	extraJson: z.string().nullable(),
	expiresAt: z.string(),
	createdAt: z.string(),
});

const turretReplaySessionSpansGroupedResponseSchema = z.object({
	spansByBreadcrumbId: z.record(z.string(), z.array(turretRequestSpanSchema)),
	limit: z.number().optional(),
	offset: z.number().optional(),
	hasMore: z.boolean().optional(),
});

type TurretIssueStatus = z.infer<typeof turretIssueStatusSchema>;
type TurretIssueView = z.infer<typeof turretIssueViewSchema>;
type TurretIssueSort = z.infer<typeof turretIssueSortSchema>;
type TurretIssuePriority = z.infer<typeof turretIssuePrioritySchema>;
type TurretIssueActivityKind = z.infer<typeof turretIssueActivityKindSchema>;
type TurretFeedbackKind = z.infer<typeof turretFeedbackKindSchema>;
type TurretFeedbackStatus = z.infer<typeof turretFeedbackStatusSchema>;
type TurretRequestSpan = z.infer<typeof turretRequestSpanSchema>;
type TurretReplaySessionSpansGroupedResponse = z.infer<
	typeof turretReplaySessionSpansGroupedResponseSchema
>;

export {
	turretIssueStatusSchema,
	turretIssueViewSchema,
	turretIssueSortSchema,
	turretIssuePrioritySchema,
	turretIssueResolveInSchema,
	turretIssueActivityKindSchema,
	TURRET_ESCALATION_FACTOR,
	TURRET_ESCALATION_MIN_OCCURRENCES,
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
	turretRequestBreadcrumbSchema,
	turretRequestSpanSchema,
	turretReplaySessionSpansGroupedResponseSchema,
};

export type {
	TurretIssueStatus,
	TurretIssueView,
	TurretIssueSort,
	TurretIssuePriority,
	TurretIssueActivityKind,
	TurretFeedbackKind,
	TurretFeedbackStatus,
	TurretRequestSpan,
	TurretReplaySessionSpansGroupedResponse,
};

export const turretInitResponseSchema = z.object({
	session_id: z.string(),
	upload_token: z.string(),
	upload_expires_at: turretTimestampMsSchema,
	policy_version: z.string(),
	rrweb: turretComplianceSchema.shape.rrweb.unwrap(),
	console: turretComplianceSchema.shape.console,
});

// Stored verbatim by ingest and streamed back from R2 by the replay reader.
export const turretReplayChunkSchema = z.object({
	seq: z.number().int().min(0),
	events: z.array(z.unknown()),
	ts_start: z.number().optional(),
	ts_end: z.number().optional(),
});
