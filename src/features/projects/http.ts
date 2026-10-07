import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	createProjectSchema,
	projectResponseSchema,
	projectsResponseSchema,
} from "./contracts";
import { resourceIdSchema } from "../../contracts/operation";
import { pageSchema } from "../../contracts/pagination";
import {
	errorResponses,
	requireUser,
	limitBody,
	operationErrorHandler,
	validationHook,
	type OperationEnv,
} from "../../worker/api/routes/_shared/operation-http";
import { createProject, listProjects } from "./operations";
const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);
const params = z.object({ organizationId: resourceIdSchema });
export const routes = app
	.openapi(
		createRoute({
			method: "get",
			path: "/organizations/{organizationId}/projects",
			middleware: [requireUser, limitBody] as const,
			request: { params, query: pageSchema },
			responses: {
				200: {
					description: "Projects, up to 50 per page",
					content: {
						"application/json": { schema: projectsResponseSchema },
					},
				},
				...errorResponses,
			},
		}),
		async (c) =>
			c.json(
				{
					projects: await listProjects(
						c.get("operation"),
						c.req.valid("param").organizationId,
						c.req.valid("query")
					),
				},
				200
			)
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/organizations/{organizationId}/projects",
			middleware: [requireUser, limitBody] as const,
			request: {
				params,
				body: {
					required: true,
					content: {
						"application/json": { schema: createProjectSchema },
					},
				},
			},
			responses: {
				201: {
					description: "Project created",
					content: {
						"application/json": { schema: projectResponseSchema },
					},
				},
				...errorResponses,
			},
		}),
		async (c) =>
			c.json(
				{
					project: await createProject(
						c.get("operation"),
						c.req.valid("param").organizationId,
						c.req.valid("json")
					),
				},
				201
			)
	);
