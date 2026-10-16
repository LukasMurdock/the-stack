import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import type { CoreDb } from "../../../bindings/d1/core/db";
import { auth_user } from "../../../bindings/d1/core/schema";
import {
	STARTING_PASSWORD_LENGTH,
	createUserSchema,
	createdUserResponseSchema,
	type CreateUserInput,
} from "../../../contracts/admin-users";
import { ProductError } from "../../../features/shared/context";
import { createAuth } from "../../auth";
import { generatePassword } from "../../generated-password";
import { recordAdminUserCreatedEvent } from "../../observability/evlog";
import {
	errorResponses,
	limitBody,
	operationErrorHandler,
	requireAdmin,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

const duplicateEmail = () =>
	new ProductError("invalid_input", "Check the submitted values.", {
		email: "A user with this email already exists.",
	});

// Under /internal/ so the OpenAPI document hides it from non-administrators.
const postUser = createRoute({
	method: "post",
	path: "/internal/users",
	middleware: [requireAdmin, limitBody] as const,
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: createUserSchema } },
		},
	},
	responses: {
		201: {
			description:
				"User created; the starting password is in this response only",
			content: {
				"application/json": { schema: createdUserResponseSchema },
			},
		},
		...errorResponses,
	},
});

export const routes = app.openapi(postUser, async (c) => {
	const input = c.req.valid("json");
	const operation = c.get("operation");
	if (await emailInUse(operation.db, input.email)) throw duplicateEmail();
	const startingPassword = generatePassword(STARTING_PASSWORD_LENGTH);
	const auth = createAuth(c.env, c.executionCtx, c.get("requestId"));
	let userId: string;
	try {
		userId = await createUser(auth, {
			headers: c.req.raw.headers,
			input,
			password: startingPassword,
		});
	} catch (error: unknown) {
		throw await translateCreateFailure(operation.db, input.email, error);
	}
	recordAdminUserCreatedEvent({
		actorId: operation.actor.userId,
		userId,
		role: input.role,
		emailVerification: input.emailVerification,
	});
	return c.json(
		{
			user: {
				id: userId,
				name: input.name,
				email: input.email,
				role: input.role,
				emailVerification: input.emailVerification,
			},
			startingPassword,
		},
		201
	);
});

async function emailInUse(db: CoreDb, email: string): Promise<boolean> {
	const [existing] = await db
		.select({ id: auth_user.id })
		.from(auth_user)
		.where(sql`lower(${auth_user.email}) = ${email}`)
		.limit(1);
	return existing !== undefined;
}

// Better Auth's admin endpoint receives the caller's headers, so it re-checks
// the admin session and applies its password policy (including the compromised
// password check) and hashing. The password is not kept after this call.
async function createUser(
	auth: ReturnType<typeof createAuth>,
	request: {
		readonly headers: Headers;
		readonly input: CreateUserInput;
		readonly password: string;
	}
): Promise<string> {
	const { input } = request;
	const created = await auth.api.createUser({
		headers: request.headers,
		body: {
			email: input.email,
			name: input.name,
			password: request.password,
			role: input.role,
			data: { emailVerified: input.emailVerification === "verified" },
		},
	});
	return created.user.id;
}

// Better Auth rejects with 400 for a duplicate created after our check (a
// concurrent request) and for input its own policy refuses. Anything else is
// an infrastructure failure and propagates unchanged.
async function translateCreateFailure(
	db: CoreDb,
	email: string,
	error: unknown
): Promise<unknown> {
	if (!(error instanceof APIError)) return error;
	if (error.statusCode !== 400) return error;
	if (await emailInUse(db, email)) return duplicateEmail();
	return new ProductError("invalid_input", error.message);
}
