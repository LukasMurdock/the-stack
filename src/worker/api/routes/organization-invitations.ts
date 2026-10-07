import { pageSchema } from "../../../contracts/pagination";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as contracts from "../../../contracts/organizations";
import {
	resourceIdSchema,
	productErrorSchema,
} from "../../../contracts/operation";
import {
	errorResponses,
	requireUser,
	limitBody,
	operationErrorHandler,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";
import * as organizations from "../../../features/organizations/invitations";
import { createAuth } from "../../auth";
import { makeCoreDb } from "../../../bindings/d1/core/db";
import { ProductError } from "../../../features/shared/context";
import { requiredSameOrigin } from "./_shared/request-security";

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

const organizationParams = z.object({
	organizationId: resourceIdSchema,
});
const invitationParams = organizationParams.extend({
	invitationId: resourceIdSchema,
});

const getInvitations = createRoute({
	method: "get",
	path: "/organizations/{organizationId}/invitations",
	middleware: [requireUser, limitBody] as const,
	request: { params: organizationParams, query: pageSchema },
	responses: {
		200: {
			description: "Pending invitations",
			content: {
				"application/json": {
					schema: contracts.invitationsResponseSchema,
				},
			},
		},
		...errorResponses,
	},
});

const postInvitations = createRoute({
	method: "post",
	path: "/organizations/{organizationId}/invitations",
	middleware: [requireUser, limitBody] as const,
	request: {
		params: organizationParams,
		body: {
			required: true,
			content: {
				"application/json": { schema: contracts.inviteMemberSchema },
			},
		},
	},
	responses: {
		200: {
			description: "Success",
			content: {
				"application/json": {
					schema: contracts.invitationResponseSchema,
				},
			},
		},
		...errorResponses,
	},
});

const deleteInvitation = createRoute({
	method: "delete",
	path: "/organizations/{organizationId}/invitations/{invitationId}",
	middleware: [requireUser, limitBody] as const,
	request: { params: invitationParams },
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

const postAccept = createRoute({
	method: "post",
	path: "/invitations/accept",
	middleware: [requireUser, limitBody] as const,
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: contracts.acceptInvitationSchema,
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

const postRegister = createRoute({
	method: "post",
	path: "/invitations/register",
	middleware: [limitBody] as const,
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: contracts.registerInvitationSchema,
				},
			},
		},
	},
	responses: {
		default: { description: "Better Auth registration failure" },
		200: {
			description:
				"Account created; verify email before accepting the invitation",
			content: {
				"application/json": { schema: contracts.acknowledgementSchema },
			},
		},
		...errorResponses,
		400: {
			description: "Invalid input or rejected account registration",
			content: {
				"application/json": {
					schema: z.union([
						productErrorSchema,
						z.object({ code: z.string(), message: z.string() }),
					]),
				},
			},
		},
		429: { description: "Better Auth registration rate limit" },
		500: { description: "Better Auth registration unavailable" },
	},
});

export const routes = app
	.openapi(postRegister, async (c) => {
		c.header("Cache-Control", "no-store");
		if (requiredSameOrigin(c.env.APP_URL, c.req.raw))
			throw new ProductError(
				"forbidden",
				"Use the application origin for this request."
			);
		const { email, name, password } =
			await organizations.invitationRegistration(
				makeCoreDb(c.env.CORE_DB),
				c.req.valid("json")
			);
		// Keep ordinary signup policy intact. Only this validated invitation request
		// uses Better Auth's HTTP handler, including its rate limits and hooks.
		const auth = createAuth(
			{ ...c.env, AUTH_SIGNUP_MODE: "open" },
			c.executionCtx
		);
		const headers = new Headers(c.req.raw.headers);
		// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Headers.delete removes HTTP metadata, not database rows.
		headers.delete("Content-Length");
		const response = await auth.handler(
			new Request(new URL("/api/auth/sign-up/email", c.req.url), {
				method: "POST",
				headers,
				body: JSON.stringify({ email, name, password }),
			})
		);
		if (!response.ok) return response;
		for (const cookie of response.headers.getSetCookie())
			c.header("Set-Cookie", cookie, { append: true });
		return c.json({ ok: true as const }, 200);
	})
	.openapi(getInvitations, async (c) =>
		c.json(
			{
				invitations: await organizations.listInvitations(
					c.get("operation"),
					c.req.valid("param").organizationId,
					c.req.valid("query")
				),
			},
			200
		)
	)
	.openapi(postInvitations, async (c) =>
		c.json(
			{
				invitation: await organizations.inviteMember(
					c.get("operation"),
					c.req.valid("param").organizationId,
					c.req.valid("json")
				),
			},
			200
		)
	)
	.openapi(deleteInvitation, async (c) => {
		const p = c.req.valid("param");
		await organizations.revokeInvitation(
			c.get("operation"),
			p.organizationId,
			p.invitationId
		);
		return c.json({ ok: true as const }, 200);
	})
	.openapi(postAccept, async (c) =>
		c.json(
			{
				organization: await organizations.acceptInvitation(
					c.get("operation"),
					c.req.valid("json")
				),
			},
			200
		)
	);
