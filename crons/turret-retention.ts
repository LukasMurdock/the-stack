import type { WorkerEnv } from "../src/worker/index";
import { runScheduledCleanup } from "../src/worker/scheduled-cleanup";

export const cron = "0 * * * *";

// Void wraps framework Workers during publication and supplies the scheduled
// handler from crons/, bundled on its own. Import only the cleanup job, never
// the API Worker (see src/worker/scheduled-cleanup.ts).
export default async function retention(
	controller: ScheduledController,
	env: WorkerEnv,
	ctx: ExecutionContext
) {
	return runScheduledCleanup(controller, env, ctx);
}
