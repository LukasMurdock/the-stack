import type { Bindings } from "../../index";
import {
	turretFeaturesSchema,
	turretFeaturesUpdateSchema,
} from "../../../contracts/turret-features";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { readTurretFeatures, writeTurretFeatures } from "../../turret/features";
import {
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";

import {
	validationHook,
	operationErrorHandler,
} from "./_shared/operation-http";
import {
	productErrorSchema,
	productErrors,
} from "../../../contracts/operation";
const internalTurretFeaturesApp = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
internalTurretFeaturesApp.onError(operationErrorHandler);

const TurretFeaturesResponseSchema = z
	.object({
		features: turretFeaturesSchema,
	})
	.openapi("TurretFeaturesResponse");

export { internalTurretFeaturesApp };

export const routes = internalTurretFeaturesApp
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/features",
			middleware: [requireInternalTurretAdmin] as const,
			responses: {
				200: {
					description: "Get turret features",
					content: {
						"application/json": {
							schema: TurretFeaturesResponseSchema,
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const features = await readTurretFeatures(c.env);
			return c.json({ features }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "put",
			path: "/internal/turret/features",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				body: {
					required: true,
					content: {
						"application/json": {
							schema: turretFeaturesUpdateSchema,
						},
					},
				},
			},
			responses: {
				[productErrors.invalid_input.status]: {
					description: productErrors.invalid_input.description,
					content: {
						"application/json": { schema: productErrorSchema },
					},
				},
				200: {
					description: "Update turret features",
					content: {
						"application/json": {
							schema: TurretFeaturesResponseSchema,
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const body = c.req.valid("json");
			const current = await readTurretFeatures(c.env);
			const next = { ...current, ...body };
			await writeTurretFeatures(c.env, next);
			return c.json({ features: next }, 200);
		}
	);
