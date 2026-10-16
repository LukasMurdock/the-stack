import type { Bindings } from "../../index";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { hashPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { makeCoreDb } from "../../../bindings/d1/core/db";

import * as schema from "../../../bindings/d1/core/schema";
import { createAuth } from "../../auth";
import { generatePassword } from "../../generated-password";
import { emailReadiness } from "./readiness";

const bootstrapApp = new OpenAPIHono<{ Bindings: Bindings }>();

// 288 bits; the operator copies it once, so length costs nothing.
const BOOTSTRAP_PASSWORD_LENGTH = 48;
const NO_STORE = { "Cache-Control": "no-store" } as const;

// How the first administrator gets a password:
// - "email" (the default, unchanged): email ADMIN_EMAIL a reset link.
// - "response": return a generated password in this response, once. For a
//   deployment that cannot send email yet. See docs/DEPLOYMENT_GUIDE.md.
const DeliverySchema = z.enum(["email", "response"]);
type Delivery = z.infer<typeof DeliverySchema>;
const BootstrapRequestSchema = z
	.strictObject({ delivery: DeliverySchema.optional() })
	.openapi("BootstrapRequest");

const BootstrapResponseSchema = z
	.object({
		ok: z.boolean(),
		status: z.enum([
			"bootstrapped",
			"already_bootstrapped",
			"invalid_request",
			"email_unavailable",
		]),
		credential: z
			.object({ email: z.string(), password: z.string() })
			.optional(),
	})
	.openapi("BootstrapResponse");

const responseContent = {
	content: { "application/json": { schema: BootstrapResponseSchema } },
};

const postBootstrapAdmin = createRoute({
	method: "post",
	path: "/internal/bootstrap-admin",
	request: {
		body: {
			required: false,
			content: { "application/json": { schema: BootstrapRequestSchema } },
		},
	},
	responses: {
		200: { description: "Bootstrap admin user", ...responseContent },
		400: { description: "Malformed request body", ...responseContent },
		409: { description: "Already bootstrapped", ...responseContent },
		401: { description: "Unauthorized", ...responseContent },
		500: { description: "Server error", ...responseContent },
		503: {
			description:
				"Email delivery is not configured; use delivery: response",
			...responseContent,
		},
	},
});

function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	let diff = aBytes.length ^ bBytes.length;
	for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}

// zod-openapi rejects a body that is not JSON before the validation hook runs.
bootstrapApp.onError((error, c) => {
	if (error instanceof HTTPException && error.status === 400)
		return c.json({ ok: false, status: "invalid_request" }, 400, NO_STORE);
	throw error;
});

const routes = bootstrapApp.openapi(
	postBootstrapAdmin,
	async (c) => {
		const env = c.env;
		const expectedSecret = env.BOOTSTRAP_SECRET;
		const providedSecret = c.req.header("x-bootstrap-secret") ?? "";
		if (!expectedSecret || !timingSafeEqual(providedSecret, expectedSecret))
			return c.json(
				{ ok: false, status: "already_bootstrapped" },
				401,
				NO_STORE
			);
		if (!env.ADMIN_EMAIL || !env.APP_URL)
			return c.json(
				{ ok: false, status: "already_bootstrapped" },
				500,
				NO_STORE
			);
		const adminEmail = env.ADMIN_EMAIL.toLowerCase();
		// An absent body keeps the original email behaviour for existing callers.
		const delivery: Delivery = c.req.valid("json").delivery ?? "email";
		// Better Auth swallows reset-email failures (so responses cannot reveal
		// accounts); without this check bootstrap would report success, burn its
		// one use, and leave nobody able to sign in.
		if (
			delivery === "email" &&
			emailReadiness(env).delivery === "unavailable"
		)
			return c.json(
				{ ok: false, status: "email_unavailable" },
				503,
				NO_STORE
			);

		const bootstrappedKey = `bootstrap:admin:${adminEmail}`;
		if (await env.CORE_KV.get(bootstrappedKey))
			return c.json(
				{ ok: true, status: "already_bootstrapped" },
				409,
				NO_STORE
			);

		const auth = createAuth(env, c.executionCtx, c.get("requestId"));
		const password = await ensureAdmin(env, auth, { adminEmail, delivery });
		if (password === undefined)
			return c.json(
				{ ok: false, status: "already_bootstrapped" },
				500,
				NO_STORE
			);
		if (delivery === "email")
			// The generated password is discarded; the admin sets their own.
			await auth.api.requestPasswordReset({
				body: {
					email: adminEmail,
					redirectTo: `${env.APP_URL}/reset-password`,
				},
			});
		await env.CORE_KV.put(bootstrappedKey, new Date().toISOString());

		if (delivery === "email")
			return c.json({ ok: true, status: "bootstrapped" }, 200, NO_STORE);
		// The only copy of the password. It is not logged or stored in plain text.
		const credential = { email: adminEmail, password };
		return c.json(
			{ ok: true, status: "bootstrapped", credential },
			200,
			NO_STORE
		);
	},
	(result, c) => {
		if (result.success) return undefined;
		return c.json({ ok: false, status: "invalid_request" }, 400, NO_STORE);
	}
);

// Creates ADMIN_EMAIL's account, or takes over an existing one, as a verified
// administrator with a fresh generated password. Returns that password, or
// undefined when the created user cannot be read back.
async function ensureAdmin(
	env: Bindings,
	auth: ReturnType<typeof createAuth>,
	request: { readonly adminEmail: string; readonly delivery: Delivery }
): Promise<string | undefined> {
	const db = makeCoreDb(env.CORE_DB);
	const password = generatePassword(BOOTSTRAP_PASSWORD_LENGTH);
	// Better Auth stores addresses lower-cased; ADMIN_EMAIL may not be.
	const existingUser = await db.query.auth_user.findFirst({
		where: sql`lower(${schema.auth_user.email}) = ${request.adminEmail}`,
	});

	let userId: string;
	if (existingUser) {
		userId = existingUser.id;
		// Email delivery leaves an existing credential alone: the reset link
		// replaces it. Showing a password must replace it now, and end every
		// session, so whoever registered this address first is locked out.
		if (request.delivery === "response")
			await replaceCredential(auth, { userId, password });
	} else {
		// Sign-up stays disabled for the public; this server-side call creates
		// the initial admin.
		await auth.api.createUser({
			body: {
				email: request.adminEmail,
				name: "Admin",
				password,
				role: "admin",
			},
		});
		const createdUser = await db.query.auth_user.findFirst({
			where: sql`lower(${schema.auth_user.email}) = ${request.adminEmail}`,
		});
		if (!createdUser) return undefined;
		userId = createdUser.id;
	}

	await db
		.update(schema.auth_user)
		.set({ emailVerified: true, role: "admin" })
		.where(eq(schema.auth_user.id, userId));
	return password;
}

// Outside an endpoint there is no admin session for Better Auth's
// set-user-password, so this uses its internal adapter directly. hashPassword
// is Better Auth's default scrypt hasher, the one this app configures (the
// same one scripts/create-admin-local.mjs uses).
async function replaceCredential(
	auth: ReturnType<typeof createAuth>,
	credential: { readonly userId: string; readonly password: string }
): Promise<void> {
	const context = await auth.$context;
	const passwordHash = await hashPassword(credential.password);
	const accounts = await context.internalAdapter.findAccounts(
		credential.userId
	);
	const hasCredential = accounts.some(
		(account) => account.providerId === "credential"
	);
	if (hasCredential) {
		await context.internalAdapter.updatePassword(
			credential.userId,
			passwordHash
		);
	} else {
		await context.internalAdapter.linkAccount({
			userId: credential.userId,
			providerId: "credential",
			accountId: credential.userId,
			password: passwordHash,
		});
	}
	await context.internalAdapter.deleteUserSessions(credential.userId);
}

export { bootstrapApp, routes };
