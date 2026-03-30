import { z } from "zod";

const turretIssueStatusSchema = z.enum(["open", "resolved", "ignored"]);
const turretFeedbackKindSchema = z.enum(["bug", "idea", "praise", "other"]);
const turretFeedbackStatusSchema = z.enum(["open", "triaged", "resolved"]);

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

const turretSessionSpansGroupedResponseSchema = z.object({
	spansByRequestId: z.record(z.string(), z.array(turretRequestSpanSchema)),
	limit: z.number().optional(),
	offset: z.number().optional(),
	hasMore: z.boolean().optional(),
});

type TurretIssueStatus = z.infer<typeof turretIssueStatusSchema>;
type TurretFeedbackKind = z.infer<typeof turretFeedbackKindSchema>;
type TurretFeedbackStatus = z.infer<typeof turretFeedbackStatusSchema>;
type TurretRequestSpan = z.infer<typeof turretRequestSpanSchema>;
type TurretSessionSpansGroupedResponse = z.infer<
	typeof turretSessionSpansGroupedResponseSchema
>;

export {
	turretIssueStatusSchema,
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
	turretRequestSpanSchema,
	turretSessionSpansGroupedResponseSchema,
};

export type {
	TurretIssueStatus,
	TurretFeedbackKind,
	TurretFeedbackStatus,
	TurretRequestSpan,
	TurretSessionSpansGroupedResponse,
};
