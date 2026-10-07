import { pageSchema } from "../../../contracts/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as contracts from "../../../contracts/organizations";
import { resourceIdSchema } from "../../../contracts/operation";
import {
	errorResponses,
	requireUser,
	limitBody,
	operationErrorHandler,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";
import * as organizations from "../../../features/organizations/operations";

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

const organizationParams = z.object({
	organizationId: resourceIdSchema,
});

const getOrganizations = createRoute({
	method: "get",
	path: "/organizations",
	middleware: [requireUser, limitBody] as const,
	request: { query: pageSchema },
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": {
					schema: contracts.organizationsResponseSchema,
				},
			},
		},
		...errorResponses,
	},
});

const postOrganizations = createRoute({
	method: "post",
	path: "/organizations",
	middleware: [requireUser, limitBody] as const,
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: contracts.createOrganizationSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": {
					schema: contracts.organizationResponseSchema,
				},
			},
		},
		...errorResponses,
	},
});

const getOrganization = createRoute({
	method: "get",
	path: "/organizations/{organizationId}",
	middleware: [requireUser, limitBody] as const,
	request: { params: organizationParams },
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": {
					schema: contracts.organizationResponseSchema,
				},
			},
		},
		...errorResponses,
	},
});

export const routes = app
	.openapi(getOrganizations, async (c) =>
		c.json(
			{
				organizations: await organizations.listOrganizations(
					c.get("operation"),
					c.req.valid("query")
				),
			},
			200
		)
	)
	.openapi(postOrganizations, async (c) =>
		c.json(
			{
				organization: await organizations.createOrganization(
					c.get("operation"),
					c.req.valid("json")
				),
			},
			200
		)
	)
	.openapi(getOrganization, async (c) =>
		c.json(
			{
				organization: await organizations.getOrganization(
					c.get("operation"),
					c.req.valid("param").organizationId
				),
			},
			200
		)
	);
