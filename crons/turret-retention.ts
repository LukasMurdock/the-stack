import apiWorker, { type Bindings } from "../src/worker/index";

export const cron = "0 * * * *";

// Void wraps framework Workers during publication and supplies the scheduled
// handler from crons/. Delegate to the same retention job as local development.
export default async function retention(
	controller: ScheduledController,
	env: Bindings,
	ctx: ExecutionContext
) {
	return apiWorker.scheduled(controller, env, ctx);
}
