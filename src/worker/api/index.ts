import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { createAuth, type AuthEnv } from "../auth";
import { routes as rootRoutes } from "./routes/root";
import { routes as bootstrapRoutes } from "./routes/bootstrap";
import { routes as internalTurretRoutes } from "./routes/internal-turret";
import { routes as internalTurretFeaturesRoutes } from "./routes/internal-turret-features";
import { routes as turretRoutes } from "./routes/turret";

const api = new OpenAPIHono();

// Capture the returned type so the client can infer routes.
const apiRoutes = api
	.route("/", rootRoutes)
	.route("/", bootstrapRoutes)
	.route("/", turretRoutes)
	.route("/", internalTurretRoutes)
	.route("/", internalTurretFeaturesRoutes);

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

type OpenApiDoc = { paths?: Record<string, unknown> };

function filterOpenApiForNonAdmin(doc: OpenApiDoc): OpenApiDoc {
	const next: OpenApiDoc = doc;

	const hiddenPrefixes = ["/turret", "/internal/"];
	if (next.paths) {
		for (const p of Object.keys(next.paths)) {
			if (hiddenPrefixes.some((prefix) => p.startsWith(prefix))) {
				delete next.paths[p];
			}
		}
	}

	return next;
}

api.get("/doc", async (c) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	const user = session?.user as unknown as { role?: string } | undefined;
	const isAdmin = isAdminRole(user?.role);

	const doc = api.getOpenAPIDocument({
		openapi: "3.0.0",
		info: {
			title: "API",
			version: "1.0.0",
		},
	});

	return c.json(isAdmin ? doc : filterOpenApiForNonAdmin(doc), 200);
});

api.get(
	"/scalar",
	Scalar({
		url: "/api/doc",
		sources: [
			{ url: "/api/auth/open-api/generate-schema", title: "Auth" },
			{ url: "/api/doc", title: "API" },
			// Better Auth schema generation endpoint
		],
	})
);

export type ApiType = typeof apiRoutes;

export { api, apiRoutes };
