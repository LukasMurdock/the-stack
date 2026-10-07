import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { turretSummarySchema } from "../../../contracts/observability";
import { loadTurretSummary } from "../../observability/summary";
import type { Bindings } from "../../index";
import {
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";

const app = new OpenAPIHono<{ Bindings: Bindings }>();

export const routes = app.openapi(
	createRoute({
		method: "get",
		path: "/internal/turret/summary",
		middleware: [requireInternalTurretAdmin] as const,
		responses: {
			...adminErrorResponses,
			200: {
				description:
					"Full hourly replay totals and sampled operational estimates",
				content: {
					"application/json": { schema: turretSummarySchema },
				},
			},
		},
	}),
	async (c) => {
		// Authenticated account-level data must never enter a shared HTTP cache.
		c.header("Cache-Control", "no-store");
		return c.json(await loadTurretSummary(c.env), 200);
	}
);
