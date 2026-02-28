import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	isOpenSignupMode,
	resolveAuthSignupMode,
} from "../../auth-signup-mode";
import { resolveTurretModeStatus } from "../../turret/mode";

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
		auth: z.object({
			signupMode: z
				.enum(["invite_only", "open"])
				.openapi({ example: "invite_only" }),
			selfSignUpEnabled: z.boolean().openapi({ example: false }),
		}),
		turret: z.object({
			configuredMode: z
				.enum(["off", "basic", "full"])
				.openapi({ example: "full" }),
			effectiveMode: z
				.enum(["off", "basic", "full"])
				.openapi({ example: "basic" }),
			ingestEnabled: z.boolean().openapi({ example: false }),
			reason: z
				.string()
				.nullable()
				.openapi({ example: "missing_turret_signing_key" }),
		}),
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
		const signupMode = resolveAuthSignupMode(
			(c.env as { AUTH_SIGNUP_MODE?: string }).AUTH_SIGNUP_MODE
		);
		const turretMode = resolveTurretModeStatus({
			modeRaw: (c.env as { TURRET_MODE?: string }).TURRET_MODE,
			hasSigningKey: Boolean(
				(c.env as { TURRET_SIGNING_KEY?: string }).TURRET_SIGNING_KEY
			),
		});
		return c.json(
			{
				ok: true,
				auth: {
					signupMode,
					selfSignUpEnabled: isOpenSignupMode(signupMode),
				},
				turret: turretMode,
			},
			200
		);
	})
	.openapi(getThrow, () => {
		throw new Error("Intentional test error");
	})
	.openapi(getFail, (c) => {
		return c.json({ error: "Intentional test 5xx" }, 500);
	});

export { rootApp, routes };
