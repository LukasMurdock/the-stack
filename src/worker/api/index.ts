import type { Bindings } from "../index";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { createAuth } from "../auth";
import { routes as readinessRoutes } from "./routes/readiness";
import { routes as rootRoutes } from "./routes/root";
import { routes as bootstrapRoutes } from "./routes/bootstrap";
import { routes as internalTurretSummaryRoutes } from "./routes/internal-turret-summary";
import { routes as internalTurretRoutes } from "./routes/internal-turret";
import { routes as internalTurretFeaturesRoutes } from "./routes/internal-turret-features";
import { routes as internalTurretComplianceRoutes } from "./routes/internal-turret-compliance";
import { routes as internalTurretIssuesRoutes } from "./routes/internal-turret-issues";
import { routes as internalTurretFeedbackRoutes } from "./routes/internal-turret-feedback";
import { routes as turretRoutes } from "./routes/turret";
import { isAdminRole } from "../../features/auth/policy";

import { routes as organizationsRoutes } from "./routes/organizations";
import { routes as organizationMemberRoutes } from "./routes/organization-members";
import { routes as organizationInvitationRoutes } from "./routes/organization-invitations";
import { routes as projectsRoutes } from "../../features/projects/http";

const api = new OpenAPIHono<{ Bindings: Bindings }>();

// Capture the returned type so the client can infer routes.
const apiRoutes = api
	.route("/", rootRoutes)
	.route("/", readinessRoutes)
	.route("/", organizationsRoutes)
	.route("/", organizationMemberRoutes)
	.route("/", organizationInvitationRoutes)
	.route("/", projectsRoutes)
	.route("/", bootstrapRoutes)
	.route("/", turretRoutes)
	.route("/", internalTurretSummaryRoutes)
	.route("/", internalTurretRoutes)
	.route("/", internalTurretFeaturesRoutes)
	.route("/", internalTurretComplianceRoutes)
	.route("/", internalTurretIssuesRoutes)
	.route("/", internalTurretFeedbackRoutes);

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
	const env = c.env;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	const user = session?.user;
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
