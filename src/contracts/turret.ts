import { turretTimestampMsSchema } from "./turret-time-range";
import { turretComplianceSchema } from "./turret-policy";
import { z } from "zod";

// Typed navigation and serialized query strings represent the same replay filter.
export const turretHasErrorSchema = z
	.union([z.boolean(), z.enum(["1", "0", "true", "false"])])
	.transform((value) => value === true || value === "1" || value === "true");

const turretIssueStatusSchema = z.enum(["open", "resolved", "ignored"]);
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

const turretRequestSpanSchema = z.object({
	id: z.string(),
	requestId: z.string(),
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
	spansByRequestId: z.record(z.string(), z.array(turretRequestSpanSchema)),
	limit: z.number().optional(),
	offset: z.number().optional(),
	hasMore: z.boolean().optional(),
});

type TurretIssueStatus = z.infer<typeof turretIssueStatusSchema>;
type TurretFeedbackKind = z.infer<typeof turretFeedbackKindSchema>;
type TurretFeedbackStatus = z.infer<typeof turretFeedbackStatusSchema>;
type TurretRequestSpan = z.infer<typeof turretRequestSpanSchema>;
type TurretReplaySessionSpansGroupedResponse = z.infer<
	typeof turretReplaySessionSpansGroupedResponseSchema
>;

export {
	turretIssueStatusSchema,
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
	turretRequestSpanSchema,
	turretReplaySessionSpansGroupedResponseSchema,
};

export type {
	TurretIssueStatus,
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
