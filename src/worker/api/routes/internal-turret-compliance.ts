import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";
import {
	readTurretCompliance,
	writeTurretCompliance,
	TurretComplianceSchema,
} from "../../turret/compliance";

type TurretCfgEnv = {
	TURRET_CFG: {
		get(key: string, type: "json"): Promise<unknown>;
		put(key: string, value: string): Promise<void>;
	};
};

const internalTurretComplianceApp = new OpenAPIHono();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const TurretComplianceResponseSchema = z
	.object({
		policy: TurretComplianceSchema,
	})
	.openapi("TurretComplianceResponse");

const TurretComplianceUpdateSchema = z
	.object({
		retentionDays: z.number().int().min(1).max(365).optional(),
		rrweb: z
			.object({
				maskAllInputs: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
		console: z
			.object({
				enabled: z.boolean().optional(),
			})
			.passthrough()
			.optional(),
	})
	.openapi("TurretComplianceUpdate");

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretComplianceApp.use("/internal/turret/*", async (c, next) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
	const user = session.user as unknown as { role?: string };
	if (!isAdminRole(user.role)) return c.json({ error: "Forbidden" }, 403);
	await next();
});

const getCompliance = createRoute({
	method: "get",
	path: "/internal/turret/compliance",
	responses: {
		200: {
			description: "Get Turret compliance policy",
			content: { "application/json": { schema: TurretComplianceResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretComplianceApp.openapi(getCompliance, async (c) => {
	const policy = await readTurretCompliance(c.env as unknown as TurretCfgEnv);
	return c.json({ policy }, 200);
});

const putCompliance = createRoute({
	method: "put",
	path: "/internal/turret/compliance",
	request: {
		body: {
			required: true,
			content: {
				"application/json": { schema: TurretComplianceUpdateSchema },
			},
		},
	},
	responses: {
		200: {
			description: "Update Turret compliance policy",
			content: { "application/json": { schema: TurretComplianceResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

internalTurretComplianceApp.openapi(putCompliance, async (c) => {
	const body = c.req.valid("json");
	const current = await readTurretCompliance(c.env as unknown as TurretCfgEnv);
	const next = {
		...current,
		...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {}),
		...(body.rrweb ? { rrweb: { ...(current.rrweb as any), ...body.rrweb } } : {}),
		...(body.console ? { console: { ...(current.console as any), ...body.console } } : {}),
	};
	// Re-parse to ensure we always store a normalized object.
	const normalized = TurretComplianceSchema.parse(next);
	await writeTurretCompliance(c.env as unknown as TurretCfgEnv, normalized);
	return c.json({ policy: normalized }, 200);
});

export { internalTurretComplianceApp };
export const routes = internalTurretComplianceApp;
