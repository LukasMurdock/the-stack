import { Hono } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";
import { observeRequest } from "./observability/request";
import type { OperationEnvironment } from "./observability/metrics";
import type { AnalyticsSqlBinding } from "./observability/summary";
import { api, apiRoutes } from "./api";
import { runScheduledCleanup } from "./scheduled-cleanup";
import { createAuth, type AuthEnv } from "./auth";
import type { SecretName } from "../contracts/secrets";
import {
	resolveSecrets,
	withResolvedSecrets,
	type SecretSources,
} from "./secrets";

// What route code sees: every secret already resolved to a string or absent.
export type Bindings = AuthEnv &
	OperationEnvironment & {
		ANALYTICS_SQL?: AnalyticsSqlBinding;
		TURRET_MODE?: string;
		CF_VERSION_METADATA?: WorkerVersionMetadata;
	};

// What Cloudflare passes: a secret is a Secrets Store binding in production
// and a plain string locally and in tests.
export type WorkerEnv = Omit<Bindings, SecretName> & SecretSources;

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
	return;
});

// Canonicalize `/api/*` to no trailing slash.
// This middleware only redirects for GET requests that result in a 404.
app.use("/api/*", trimTrailingSlash());

app.on(["GET", "POST"], "/api/auth/*", (c) =>
	createAuth(c.env, c.executionCtx, c.get("requestId")).handler(c.req.raw)
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
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		// A new object per request: Cloudflare's shared environment object is
		// never modified, and secrets are read once for this request.
		const secrets = await resolveSecrets(env);
		return app.fetch(request, withResolvedSecrets(env, secrets), ctx);
	},
	scheduled(
		controller: ScheduledController,
		env: WorkerEnv,
		ctx: ExecutionContext
	): Promise<void> {
		return runScheduledCleanup(controller, env, ctx);
	},
};
