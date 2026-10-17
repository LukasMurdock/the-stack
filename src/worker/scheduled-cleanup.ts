import { createRequestLogger } from "evlog";
import { makeTurretDb } from "../bindings/d1/turret/db";
import { cleanupAuthStorage } from "./auth-storage";
import type { WorkerEnv } from "./index";
import { traceOperation } from "./observability/tracing";
import { cleanupTurretStorage } from "./turret/retention";

// The hourly cleanup, shared by the API Worker's scheduled handler (local
// development) and crons/turret-retention.ts (Void publication). Void bundles
// crons/ separately and keeps only that bundle's entry file, so this module's
// import graph must stay small and free of dynamic import(): importing the API
// Worker here would pull in every route, auth and the email templates, split
// the bundle into chunks, and break `void deploy`. `pnpm check:deploy` fails
// if that happens.
export async function runScheduledCleanup(
	controller: ScheduledController,
	env: WorkerEnv,
	ctx: ExecutionContext
): Promise<void> {
	// At-least-once delivery: this must be safe to run multiple times.
	const now = Date.now();
	const db = env.TURRET_DB;
	const requestId = crypto.randomUUID();
	const log = createRequestLogger({
		requestId,
		waitUntil: ctx.waitUntil.bind(ctx),
	});
	log.set({
		action: "turret.cleanup",
		app: { env: env.APP_ENV, version: env.CF_VERSION_METADATA?.id },
		cron: controller.cron,
	});
	try {
		await traceOperation(
			ctx,
			"turret.cleanup",
			{
				"request.id": requestId,
				"app.env": env.APP_ENV,
				"app.version": env.CF_VERSION_METADATA?.id,
			},
			async () => {
				await cleanupAuthStorage(env.CORE_DB);
				if (!db) {
					log.set({ skipped: "missing_turret_db" });
					return;
				}

				log.set(
					await cleanupTurretStorage(
						makeTurretDb(db),
						env.TURRET_REPLAY_BUCKET,
						now
					)
				);
			}
		);
	} catch (error) {
		log.error(error instanceof Error ? error : String(error));
		throw error;
	} finally {
		log.set({ durationMs: Math.max(0, Date.now() - now) });
		log.emit();
	}
}
