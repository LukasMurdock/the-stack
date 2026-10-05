import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { sql } from "drizzle-orm";
import { makeTurretDb } from "../bindings/d1/turret/db";
import * as turretSchema from "../bindings/d1/turret/schema";
import { observeRequest } from "./observability/request";
import type { OperationEnvironment } from "./observability/metrics";
import type { AnalyticsSqlBinding } from "./observability/summary";
import { traceOperation } from "./observability/tracing";
import { createRequestLogger } from "evlog";
import { api, apiRoutes } from "./api";
import { createAuth, type AuthEnv } from "./auth";

export type Bindings = AuthEnv &
	OperationEnvironment & {
		ANALYTICS_SQL?: AnalyticsSqlBinding;
		CF_VERSION_METADATA?: WorkerVersionMetadata;
	};

const app = new Hono<{ Bindings: Bindings }>({
	strict: true,
});

const LOCAL_DEV_CORS_ORIGINS = new Set([
	"http://localhost:4321",
	"http://127.0.0.1:4321",
]);

function isLocalOrDevEnvironment(appEnv: string | undefined): boolean {
	const normalized = (appEnv ?? "").toLowerCase();
	return (
		normalized === "local" ||
		normalized === "dev" ||
		normalized === "development"
	);
}

function resolveAppOrigin(appUrl: string | undefined): string | null {
	if (!appUrl) return null;
	try {
		return new URL(appUrl).origin;
	} catch {
		return null;
	}
}

function resolveAllowedCorsOrigins(env: {
	APP_ENV?: string;
	APP_URL?: string;
}): Set<string> {
	const allowed = new Set<string>();

	const appOrigin = resolveAppOrigin(env.APP_URL);
	if (appOrigin) allowed.add(appOrigin);

	if (isLocalOrDevEnvironment(env.APP_ENV)) {
		for (const origin of LOCAL_DEV_CORS_ORIGINS) {
			allowed.add(origin);
		}
	}

	return allowed;
}

function setCorsHeaders(
	c: { header(name: string, value: string): void },
	origin: string
): void {
	c.header("Access-Control-Allow-Origin", origin);
	c.header(
		"Access-Control-Allow-Methods",
		"GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"
	);
	c.header(
		"Access-Control-Allow-Headers",
		"Authorization,Content-Type,X-Requested-With,X-Request-Id,X-Turret-Session-Id,X-Turret-Replay-Ts"
	);
	c.header("Access-Control-Max-Age", "86400");
	c.header("Access-Control-Expose-Headers", "X-Request-Id");
	c.header("Vary", "Origin");
}

app.use("*", observeRequest);

// CORS should be registered before routes.
app.use("/api/*", async (c, next) => {
	const origin = c.req.header("origin");
	if (!origin) {
		if (c.req.method === "OPTIONS") {
			return c.body(null, 204);
		}
		await next();
		return;
	}

	const allowedOrigins = resolveAllowedCorsOrigins(c.env);
	if (!allowedOrigins.has(origin)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	if (c.req.method === "OPTIONS") {
		setCorsHeaders(c, origin);
		return c.body(null, 204);
	}

	await next();
	setCorsHeaders(c, origin);
});

// Canonicalize `/api/*` to no trailing slash.
// This middleware only redirects for GET requests that result in a 404.
app.use("/api/*", trimTrailingSlash());

app.on(["GET", "POST"], "/api/auth/*", (c) =>
	createAuth(c.env, c.executionCtx).handler(c.req.raw)
);

app.route("/api", api);

app.onError((err, c) => {
	// Keep the Error object so Cloudflare Issues receives its original stack.
	console.error(err);

	return c.json(
		{
			error: "Internal Server Error",
		},
		500
	);
});

// 404 handler
app.notFound((c) => {
	return c.json({ error: "Not Found" }, 404);
});

export type ApiType = typeof apiRoutes;

export default {
	fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		// Never replace bindings on Cloudflare's shared environment object.
		return app.fetch(request, { ...env }, ctx);
	},
	async scheduled(
		controller: ScheduledController,
		env: Bindings,
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
					if (!db) {
						log.set({ skipped: "missing_turret_db" });
						return;
					}

					const turretDb = makeTurretDb(db);
					// Delete spans first, then breadcrumbs.
					await turretDb
						.delete(turretSchema.turretRequestSpans)
						.where(
							sql`${turretSchema.turretRequestSpans.expiresAt} < ${now}`
						);
					await turretDb
						.delete(turretSchema.turretRequestBreadcrumbs)
						.where(
							sql`${turretSchema.turretRequestBreadcrumbs.expiresAt} < ${now}`
						);
					await turretDb
						.delete(turretSchema.turretSessionErrors)
						.where(
							sql`${turretSchema.turretSessionErrors.expiresAt} < ${now}`
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
	},
};
