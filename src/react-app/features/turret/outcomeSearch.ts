import { z } from "zod";
import {
	type TurretWorkflow,
	turretOutcomeStatusSchema,
	turretWorkflowSchema,
} from "../../../contracts/turret-outcomes";
import {
	turretListPageDefaults,
	turretListPageSchema,
} from "../../../contracts/turret-pagination";

export const outcomePresetSchema = z.enum(["24h", "7d", "30d"]);
export const outcomeStatusLabels = {
	succeeded: "Succeeded",
	failed: "Failed",
	abandoned: "Abandoned",
	in_progress: "In progress",
} satisfies Record<z.infer<typeof turretOutcomeStatusSchema>, string>;

const WORKFLOW_DEFAULT: TurretWorkflow = "project.create";

export const outcomesSearchSchema = z.object({
	preset: outcomePresetSchema.default("7d").catch("7d"),
	workflow: turretWorkflowSchema
		.default(WORKFLOW_DEFAULT)
		.catch(WORKFLOW_DEFAULT),
	// Failures are where investigation starts.
	status: turretOutcomeStatusSchema.default("failed").catch("failed"),
	offset: turretListPageSchema.shape.offset.catch(
		turretListPageDefaults.offset
	),
});

// Successful attempts, as a share of attempts that have finished.
export function successRate(summary: {
	succeeded: number;
	failed: number;
	abandoned: number;
}) {
	const finished = summary.succeeded + summary.failed + summary.abandoned;
	return finished === 0 ? null : summary.succeeded / finished;
}
