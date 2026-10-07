import { z } from "zod";
import { turretTimestampMsSchema } from "./turret-time-range";

// The product workflows Turret measures. Keep this list small: each entry is
// a task users try to complete, instrumented where the task starts and ends.
export const turretWorkflowSchema = z.enum([
	"project.create",
	"invitation.accept",
]);
export type TurretWorkflow = z.infer<typeof turretWorkflowSchema>;
export const turretWorkflowLabels = {
	"project.create": "Create a project",
	"invitation.accept": "Accept an invitation",
} satisfies Record<TurretWorkflow, string>;

// An attempt starts, may fail any number of times, and ends at its first
// success. Failures are reported as short codes, never as user content.
export const turretOutcomeEventSchema = z.enum([
	"started",
	"failed",
	"succeeded",
]);
export const turretOutcomeBodySchema = z.object({
	attemptId: z.uuid(),
	workflow: turretWorkflowSchema,
	event: turretOutcomeEventSchema,
	ts: turretTimestampMsSchema,
	reason: z
		.string()
		.regex(/^[a-z0-9_.-]{1,64}$/, "Use a short lowercase reason code.")
		.optional(),
});

// An attempt without a success that has been quiet this long is over: failed
// if it hit any failure, otherwise abandoned.
export const TURRET_OUTCOME_IDLE_MS = 30 * 60 * 1000;
export const turretOutcomeStatusSchema = z.enum([
	"succeeded",
	"failed",
	"abandoned",
	"in_progress",
]);
export type TurretOutcomeStatus = z.infer<typeof turretOutcomeStatusSchema>;
