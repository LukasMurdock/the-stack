import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	readTurretCompliance,
	writeTurretCompliance,
	TurretComplianceSchema,
} from "../../turret/compliance";
import { requireInternalTurretAdmin } from "./_shared/admin-auth";

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

internalTurretComplianceApp.use(
	"/internal/turret/*",
	requireInternalTurretAdmin
);

const getCompliance = createRoute({
	method: "get",
	path: "/internal/turret/compliance",
	responses: {
		200: {
			description: "Get Turret compliance policy",
			content: {
				"application/json": { schema: TurretComplianceResponseSchema },
			},
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
			content: {
				"application/json": { schema: TurretComplianceResponseSchema },
			},
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
	const current = await readTurretCompliance(
		c.env as unknown as TurretCfgEnv
	);
	const next = {
		...current,
		...(body.retentionDays !== undefined
			? { retentionDays: body.retentionDays }
			: {}),
		...(body.rrweb
			? { rrweb: { ...(current.rrweb as any), ...body.rrweb } }
			: {}),
		...(body.console
			? { console: { ...(current.console as any), ...body.console } }
			: {}),
	};
	// Re-parse to ensure we always store a normalized object.
	const normalized = TurretComplianceSchema.parse(next);
	await writeTurretCompliance(c.env as unknown as TurretCfgEnv, normalized);
	return c.json({ policy: normalized }, 200);
});

export { internalTurretComplianceApp };
export const routes = internalTurretComplianceApp;
