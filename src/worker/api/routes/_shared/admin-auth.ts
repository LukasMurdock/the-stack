import { isAdminRole } from "../../../../features/auth/policy";
import { z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../../../index";
import { createAuth } from "../../../auth";

export const adminErrorResponseSchema = z
	.object({ error: z.string() })
	.openapi("TurretAdminErrorResponse");

const unauthorizedError = { error: "Unauthorized" } as const;
const forbiddenError = { error: "Forbidden" } as const;

export const adminErrorResponses = {
	401: {
		description: unauthorizedError.error,
		content: { "application/json": { schema: adminErrorResponseSchema } },
	},
	403: {
		description: forbiddenError.error,
		content: { "application/json": { schema: adminErrorResponseSchema } },
	},
} as const;

const requireInternalTurretAdmin: MiddlewareHandler<{
	Bindings: Bindings;
}> = async (c, next) => {
	const env = c.env;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });

	if (!session?.user) {
		return c.json(unauthorizedError, 401);
	}

	const user = session.user;
	if (!isAdminRole(user.role)) {
		return c.json(forbiddenError, 403);
	}

	await next();
};

export { requireInternalTurretAdmin };
