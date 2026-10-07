import { z } from "zod";

// Playback starts shortly before the focused evidence so the lead-up is visible.
export const TURRET_REPLAY_LEAD_MS = 5_000;
// The nearby timeline covers the lead-up to the focus and its aftermath.
export const TURRET_NEARBY_BEFORE_MS = 2 * 60_000;
export const TURRET_NEARBY_AFTER_MS = 30_000;

// A self-contained record of an investigation for people, tickets, and coding
// agents. It holds observed facts and links back to the evidence, never
// conclusions. It omits who was affected: no user IDs, emails, or contact
// details. Report messages are included as user-provided text.
const timestamp = z.number();

const requestSchema = z.object({
	method: z.string(),
	path: z.string(),
	status: z.number(),
	durationMs: z.number(),
	requestId: z.string(),
	rayId: z.string().nullable(),
	database: z.object({
		queries: z.number(),
		timeMs: z.number(),
		rowsRead: z.number(),
		rowsWritten: z.number(),
		errors: z.number(),
	}),
	spans: z.array(
		z.object({
			kind: z.string(),
			durationMs: z.number(),
			statement: z.string().nullable(),
			error: z.string().nullable(),
		})
	),
});

export const turretInvestigationExportSchema = z.object({
	version: z.literal(1),
	generatedAt: timestamp,
	issue: z.object({
		fingerprint: z.string(),
		title: z.string().nullable(),
		url: z.string(),
		status: z.string(),
		priority: z.string(),
		resolvedAt: timestamp.nullable(),
		resolvedInDeployment: z.string().nullable(),
		regressedAt: timestamp.nullable(),
		firstSeenAt: timestamp,
		lastSeenAt: timestamp,
		occurrences: z.number(),
		reports: z.number(),
		replaySessions: z.number(),
		users: z.number(),
		deployments: z.array(
			z.object({
				deployment: z.string().nullable(),
				occurrences: z.number(),
				firstSeenAt: timestamp,
				lastSeenAt: timestamp,
			})
		),
	}),
	// The evidence the investigation centers on.
	focus: z
		.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("error"),
				id: z.string(),
				ts: timestamp,
				source: z.string(),
				message: z.string().nullable(),
				stack: z.string().nullable(),
				requestId: z.string().nullable(),
				rayId: z.string().nullable(),
				deployment: z.string().nullable(),
				route: z.string().nullable(),
				httpStatus: z.number().nullable(),
				request: requestSchema.nullable(),
			}),
			z.object({
				kind: z.literal("report"),
				id: z.string(),
				ts: timestamp,
				reportKind: z.string(),
				message: z.string(),
				page: z.string().nullable(),
			}),
		])
		.nullable(),
	replay: z.object({ available: z.boolean(), url: z.string().nullable() }),
	// The focused replay session's requests, errors, and reports around the focus.
	timeline: z.array(
		z.object({
			ts: timestamp,
			offsetMs: z.number(),
			kind: z.enum(["request", "error", "report"]),
			summary: z.string(),
			focus: z.boolean(),
		})
	),
	reports: z.array(
		z.object({ ts: timestamp, kind: z.string(), message: z.string() })
	),
	notes: z.array(z.object({ createdAt: timestamp, body: z.string() })),
	links: z.array(z.string()),
	recovery: z
		.object({
			verdict: z.string(),
			sessionsBefore: z.number(),
			affectedBefore: z.number(),
			sessionsAfter: z.number(),
			affectedAfter: z.number(),
		})
		.nullable(),
	// Evidence the export lacks, so readers don't mistake absence for health.
	notCaptured: z.array(z.string()),
});

export type TurretInvestigationExport = z.infer<
	typeof turretInvestigationExportSchema
>;
