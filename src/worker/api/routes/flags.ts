import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	clientFlagKeys,
	featureFlags,
	flagsResponseSchema,
} from "../../../contracts/feature-flags";
import { resourceIdSchema } from "../../../contracts/operation";
import { makeCoreDb } from "../../../bindings/d1/core/db";
import { requireMembership } from "../../../features/organizations/authorization";
import { ProductError } from "../../../features/shared/context";
import { createAuth } from "../../auth";
import { requestFlags } from "../../flags";
import type { Bindings } from "../../index";
import {
	errorResponses,
	operationErrorHandler,
	validationHook,
} from "./_shared/operation-http";

// Flags stay server-authoritative: the browser receives evaluated values for
// the client flags only, for the signed-in user and, when given, an
// organization they belong to.
const app = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
app.onError(operationErrorHandler);

const query = z.object({ organizationId: resourceIdSchema.optional() });

export const routes = app.openapi(
	createRoute({
		method: "get",
		path: "/flags",
		request: { query },
		responses: {
			200: {
				description: "Evaluated client feature flags",
				content: {
					"application/json": { schema: flagsResponseSchema },
				},
			},
			...errorResponses,
		},
	}),
	async (c) => {
		c.header("Cache-Control", "no-store");
		const session = await createAuth(c.env, c.executionCtx).api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session?.user)
			throw new ProductError("unauthorized", "Sign in to continue.");
		const { organizationId } = c.req.valid("query");
		if (organizationId !== undefined)
			await requireMembership(
				{
					db: makeCoreDb(c.env.CORE_DB),
					actor: { userId: session.user.id },
				},
				organizationId
			);
		const flags = await requestFlags({
			binding: c.env.FLAGS,
			subject: {
				userId: session.user.id,
				role: session.user.role,
				organizationId,
			},
			keys: clientFlagKeys(featureFlags),
		});
		return c.json({ flags }, 200);
	}
);
