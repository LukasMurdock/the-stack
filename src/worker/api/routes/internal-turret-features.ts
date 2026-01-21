import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";
import { readTurretFeatures, writeTurretFeatures } from "../../turret/features";

type TurretCfgEnv = {
	TURRET_CFG: {
		get(key: string, type: "json"): Promise<unknown>;
		put(key: string, value: string): Promise<void>;
	};
};

const internalTurretFeaturesApp = new OpenAPIHono();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const TurretFeaturesSchema = z
	.object({
		storeUserEmail: z.boolean(),
	})
	.openapi("TurretFeatures");

const TurretFeaturesResponseSchema = z
	.object({
		features: TurretFeaturesSchema,
	})
	.openapi("TurretFeaturesResponse");

const TurretFeaturesUpdateSchema = z
	.object({
		storeUserEmail: z.boolean().optional(),
	})
	.openapi("TurretFeaturesUpdate");

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => r === "admin");
}

internalTurretFeaturesApp.use("/internal/turret/*", async (c, next) => {
	const env = c.env as unknown as AuthEnv;
	const auth = createAuth(env, c.executionCtx);

	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
	const user = session.user as unknown as { role?: string };
	if (!isAdminRole(user.role)) return c.json({ error: "Forbidden" }, 403);

	await next();
});
const getFeatures = createRoute({
	method: "get",
	path: "/internal/turret/features",
	responses: {
		200: {
			description: "Get turret features",
			content: {
				"application/json": {
					schema: TurretFeaturesResponseSchema,
				},
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

internalTurretFeaturesApp.openapi(getFeatures, async (c) => {
	const features = await readTurretFeatures(c.env as unknown as TurretCfgEnv);
	return c.json({ features }, 200);
});

const putFeatures = createRoute({
	method: "put",
	path: "/internal/turret/features",
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: TurretFeaturesUpdateSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: "Update turret features",
			content: {
				"application/json": {
					schema: TurretFeaturesResponseSchema,
				},
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

internalTurretFeaturesApp.openapi(putFeatures, async (c) => {
	const body = c.req.valid("json");
	const current = await readTurretFeatures(c.env as unknown as TurretCfgEnv);
	const next = {
		...current,
		...(body.storeUserEmail !== undefined ? { storeUserEmail: body.storeUserEmail } : {}),
	};
	await writeTurretFeatures(c.env as unknown as TurretCfgEnv, next);
	return c.json({ features: next }, 200);
});

export { internalTurretFeaturesApp };
export const routes = internalTurretFeaturesApp;
