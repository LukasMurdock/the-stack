import { pageSchema } from "../../../contracts/pagination";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import * as contracts from "../../../contracts/organizations";
import {
	errorResponses,
	requireUser,
	limitBody,
	operationErrorHandler,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";
import * as organizations from "../../../features/organizations/members";

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

const memberParams = contracts.memberTargetSchema;
const organizationParams = memberParams.pick({ organizationId: true });

const getMembers = createRoute({
	method: "get",
	path: "/organizations/{organizationId}/members",
	middleware: [requireUser, limitBody] as const,
	request: { params: organizationParams, query: pageSchema },
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": { schema: contracts.membersResponseSchema },
			},
		},
		...errorResponses,
	},
});

const putMember = createRoute({
	method: "put",
	path: "/organizations/{organizationId}/members/{userId}",
	middleware: [requireUser, limitBody] as const,
	request: {
		params: memberParams,
		body: {
			required: true,
			content: {
				"application/json": { schema: contracts.changeMemberSchema },
			},
		},
	},
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": { schema: contracts.acknowledgementSchema },
			},
		},
		...errorResponses,
	},
});

const deleteMember = createRoute({
	method: "delete",
	path: "/organizations/{organizationId}/members/{userId}",
	middleware: [requireUser, limitBody] as const,
	request: { params: memberParams },
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": { schema: contracts.acknowledgementSchema },
			},
		},
		...errorResponses,
	},
});

export const routes = app
	.openapi(getMembers, async (c) =>
		c.json(
			{
				members: await organizations.listMembers(
					c.get("operation"),
					c.req.valid("param").organizationId,
					c.req.valid("query")
				),
			},
			200
		)
	)
	.openapi(putMember, async (c) => {
		const p = c.req.valid("param");
		await organizations.changeMember(
			c.get("operation"),
			p.organizationId,
			p.userId,
			c.req.valid("json")
		);
		return c.json({ ok: true as const }, 200);
	})
	.openapi(deleteMember, async (c) => {
		const p = c.req.valid("param");
		await organizations.removeMember(
			c.get("operation"),
			p.organizationId,
			p.userId
		);
		return c.json({ ok: true as const }, 200);
	});
