import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const rootApp = new OpenAPIHono();

const NameResponseSchema = z
	.object({
		name: z.string().openapi({ example: "Cloudflare" }),
	})
	.openapi("NameResponse");

const getRoot = createRoute({
	method: "get",
	path: "",
	responses: {
		200: {
			description: "Get API name",
			content: {
				"application/json": {
					schema: NameResponseSchema,
				},
			},
		},
	},
});

const rootRoutes = rootApp.openapi(getRoot, (c) => {
	return c.json({ name: "Cloudflare" }, 200);
});

const HealthResponseSchema = z
	.object({
		ok: z.boolean().openapi({ example: true }),
	})
	.openapi("HealthResponse");

const getHealth = createRoute({
	method: "get",
	path: "/health",
	responses: {
		200: {
			description: "Health check",
			content: {
				"application/json": {
					schema: HealthResponseSchema,
				},
			},
		},
	},
});

const getThrow = createRoute({
	method: "get",
	path: "/throw",
	responses: {
		500: {
			description: "Throws (test endpoint)",
		},
	},
});

const getFail = createRoute({
	method: "get",
	path: "/fail",
	responses: {
		500: {
			description: "Returns 500 (test endpoint)",
		},
	},
});

const routes = rootRoutes
	.openapi(getHealth, (c) => {
		return c.json({ ok: true }, 200);
	})
	.openapi(getThrow, () => {
		throw new Error("Intentional test error");
	})
	.openapi(getFail, (c) => {
		return c.json({ error: "Intentional test 5xx" }, 500);
	});

export { rootApp, routes };
