import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";
import { readTurretUptimeStatus } from "../../turret/uptime";

type UptimeKVEnv = {
	TURRET_UPTIME: {
		get(key: string, type: "json"): Promise<unknown>;
	};
};

const internalTurretUptimeApp = new OpenAPIHono();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const UptimeServiceSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		status: z.enum(["up", "down", "unknown"]),
		checkedAtMs: z.number(),
		latencyMs: z.number().nullable(),
		httpStatus: z.number().nullable(),
		message: z.string().nullable(),
	})
	.openapi("UptimeService");

const UptimeStateSchema = z
	.object({
		version: z.literal(1),
		updatedAtMs: z.number(),
		overall: z.enum(["up", "degraded", "down", "unknown"]),
		services: z.array(UptimeServiceSchema),
	})
	.openapi("UptimeState");

const UptimeResponseSchema = z
	.object({
		status: UptimeStateSchema,
	})
	.openapi("UptimeResponse");

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretUptimeApp.use("/internal/turret/*", async (c, next) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
	const user = session.user as unknown as { role?: string };
	if (!isAdminRole(user.role)) return c.json({ error: "Forbidden" }, 403);
	await next();
});

const getUptime = createRoute({
	method: "get",
	path: "/internal/turret/uptime",
	responses: {
		200: {
			description: "Get uptime status snapshot",
			content: { "application/json": { schema: UptimeResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		502: {
			description: "Uptime service error",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretUptimeApp.openapi(getUptime, async (c) => {
	const status = (await readTurretUptimeStatus(c.env as unknown as UptimeKVEnv)) as z.infer<
		typeof UptimeStateSchema
	>;
	c.header("Cache-Control", "no-store");
	return c.json({ status }, 200);
});

export { internalTurretUptimeApp };
export const routes = internalTurretUptimeApp;
