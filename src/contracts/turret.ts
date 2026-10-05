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
	policy_version: z.string(),
	rrweb: z.record(z.string(), z.unknown()),
	console: z
		.object({
			enabled: z.boolean().default(true),
			level: z
				.array(z.enum(["log", "info", "warn", "error"]))
				.default(["log", "info", "warn", "error"]),
			lengthThreshold: z.number().int().min(0).default(200),
			stringifyOptions: z
				.object({
					stringLengthLimit: z.number().int().optional(),
					numOfKeysLimit: z.number().int().min(0).default(30),
					depthOfLimit: z.number().int().min(0).default(2),
				})
				.default({ numOfKeysLimit: 30, depthOfLimit: 2 }),
		})
		.default({
			enabled: true,
			level: ["log", "info", "warn", "error"],
			lengthThreshold: 200,
			stringifyOptions: { numOfKeysLimit: 30, depthOfLimit: 2 },
		}),
});
