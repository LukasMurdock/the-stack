import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createAuth, type AuthEnv } from "../../auth";

type KVNamespace = {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
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

const FEATURES_KEY = "cfg:turret:features";

function normalizeFeatures(input: unknown): z.infer<typeof TurretFeaturesSchema> {
	const obj = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	return {
		storeUserEmail: (obj.storeUserEmail as unknown) === true,
	};
}

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
	const raw = await (c.env as { TURRET_CFG: KVNamespace }).TURRET_CFG.get(FEATURES_KEY, "json");
	return c.json({ features: normalizeFeatures(raw) }, 200);
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
	const next = {
		storeUserEmail: body.storeUserEmail === true,
	};
	await (c.env as { TURRET_CFG: KVNamespace }).TURRET_CFG.put(FEATURES_KEY, JSON.stringify(next));
	return c.json({ features: next }, 200);
});

export { internalTurretFeaturesApp };
export const routes = internalTurretFeaturesApp;
