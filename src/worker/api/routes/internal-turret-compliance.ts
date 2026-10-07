import type { Bindings } from "../../index";
import {
	turretComplianceSchema,
	turretComplianceUpdateSchema,
	applyTurretComplianceUpdate,
} from "../../../contracts/turret-policy";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	readTurretCompliance,
	writeTurretCompliance,
} from "../../turret/compliance";
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
const internalTurretComplianceApp = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
internalTurretComplianceApp.onError(operationErrorHandler);

const TurretComplianceResponseSchema = z
	.object({
		policy: turretComplianceSchema,
	})
	.openapi("TurretComplianceResponse");

export { internalTurretComplianceApp };

export const routes = internalTurretComplianceApp
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/compliance",
			middleware: [requireInternalTurretAdmin] as const,
			responses: {
				200: {
					description: "Get Turret compliance policy",
					content: {
						"application/json": {
							schema: TurretComplianceResponseSchema,
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const policy = await readTurretCompliance(c.env);
			return c.json({ policy }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "put",
			path: "/internal/turret/compliance",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				body: {
					required: true,
					content: {
						"application/json": {
							schema: turretComplianceUpdateSchema,
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
					description: "Update Turret compliance policy",
					content: {
						"application/json": {
							schema: TurretComplianceResponseSchema,
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const body = c.req.valid("json");
			const current = await readTurretCompliance(c.env);
			const normalized = applyTurretComplianceUpdate(current, body);
			await writeTurretCompliance(c.env, normalized);
			return c.json({ policy: normalized }, 200);
		}
	);
