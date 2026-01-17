import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { makeCoreDb } from "../../../bindings/d1/core/db";

// OpenAPIHono's route typing is strict about enumerated status codes.
// For early-return error handling, we cast to never to keep the code readable.
import * as schema from "../../../bindings/d1/core/schema";
import { createAuth, type AuthEnv } from "../../auth";

const bootstrapApp = new OpenAPIHono();

const BootstrapResponseSchema = z
	.object({
		ok: z.boolean(),
		status: z.enum(["bootstrapped", "already_bootstrapped"]),
	})
	.openapi("BootstrapResponse");

const postBootstrapAdmin = createRoute({
	method: "post",
	path: "/internal/bootstrap-admin",
	responses: {
		200: {
			description: "Bootstrap admin user",
			content: {
				"application/json": { schema: BootstrapResponseSchema },
			},
		},
		409: {
			description: "Already bootstrapped",
			content: {
				"application/json": { schema: BootstrapResponseSchema },
			},
		},
		401: {
			description: "Unauthorized",
			content: {
				"application/json": { schema: BootstrapResponseSchema },
			},
		},
		500: {
			description: "Server error",
			content: {
				"application/json": { schema: BootstrapResponseSchema },
			},
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

function randomPassword(length = 48): string {
	// URL-safe base64-ish: 6 bits per char.
	const alphabet =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += alphabet[bytes[i] % alphabet.length];
	}
	return out;
}

const routes = bootstrapApp.openapi(postBootstrapAdmin, async (c) => {
	const env = c.env as unknown as AuthEnv & {
		BOOTSTRAP_SECRET?: string;
		ADMIN_EMAIL?: string;
		APP_URL?: string;
	};

	const expectedSecret = env.BOOTSTRAP_SECRET;
	const providedSecret = c.req.header("x-bootstrap-secret") ?? "";
	if (!expectedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
		return c.json(
			{ ok: false, status: "already_bootstrapped" },
			401,
			{ "Cache-Control": "no-store" }
		) as never;
	}

	const adminEmail = env.ADMIN_EMAIL;
	if (!adminEmail) {
		return c.json(
			{ ok: false, status: "already_bootstrapped" },
			500,
			{ "Cache-Control": "no-store" }
		) as never;
	}

	if (!env.APP_URL) {
		return c.json(
			{ ok: false, status: "already_bootstrapped" },
			500,
			{ "Cache-Control": "no-store" }
		) as never;
	}

	const bootstrappedKey = `bootstrap:admin:${adminEmail.toLowerCase()}`;
	const already = await env.CORE_KV.get(bootstrappedKey);
	if (already) {
		return c.json(
			{ ok: true, status: "already_bootstrapped" },
			409,
			{ "Cache-Control": "no-store" }
		) as never;
	}

	const db = makeCoreDb(env.CORE_DB);

	// If the user already exists (maybe created manually), just ensure it's admin + verified.
	const existingUser = await db.query.auth_user.findFirst({
		where: eq(schema.auth_user.email, adminEmail),
	});

	let userId: string;
	if (existingUser) {
		userId = existingUser.id;
	} else {
		const password = randomPassword();

		// We keep sign-up disabled for public users, but allow this endpoint to
		// create the initial admin via the server-side API.
		const auth = createAuth(env, c.executionCtx);
		await auth.api.createUser({
			body: {
				email: adminEmail,
				name: "Admin",
				password,
				role: "admin",
			},
		});

		const createdUser = await db.query.auth_user.findFirst({
			where: eq(schema.auth_user.email, adminEmail),
		});

		if (!createdUser) {
			return c.json(
				{ ok: false, status: "already_bootstrapped" },
				500,
				{ "Cache-Control": "no-store" }
			) as never;
		}

		userId = createdUser.id;
	}

	await db
		.update(schema.auth_user)
		.set({
			emailVerified: true,
			role: "admin",
		})
		.where(eq(schema.auth_user.id, userId));

	// Trigger the reset password email so the admin sets their real password.
	const auth = createAuth(env, c.executionCtx);
	await auth.api.requestPasswordReset({
		body: {
			email: adminEmail,
			redirectTo: `${env.APP_URL}/reset-password`,
		},
	});

	await env.CORE_KV.put(bootstrappedKey, new Date().toISOString());

	return c.json(
		{ ok: true, status: "bootstrapped" },
		200,
		{ "Cache-Control": "no-store" }
	);
});

export { bootstrapApp, routes };
