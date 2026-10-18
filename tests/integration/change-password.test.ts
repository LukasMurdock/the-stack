import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { passwordSchema } from "../../src/contracts/auth";
import { createAuth } from "../../src/worker/auth";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";

const origin = "http://localhost:4321";
const startingPassword = "Starting-password-123!";
const changedPassword = "Changed-credential-492873!";
const errorSchema = z.object({ code: z.string() });

// Better Auth's HTTP handler over the migrated SQLite database; only the
// compromised-password lookup, an external service, is answered locally.
async function changePasswordFixture(t: test.TestContext) {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0");
	});
	f.sqlite
		.prepare(
			"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, 'owner', 'credential', 'owner', ?, ?)"
		)
		.run(
			crypto.randomUUID(),
			await hashPassword(startingPassword),
			Date.now()
		);
	const auth = createAuth(
		testBindings({
			CORE_DB: f.binding,
			APP_URL: origin,
			APP_ENV: "test",
			EMAIL_TRANSPORT: "log",
			BETTER_AUTH_SECRET:
				"integration-secret-at-least-thirty-two-characters",
			PRODUCT_NAME: "Test",
		})
	);
	function post(path: string, body: unknown, token?: string) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Origin: origin,
		};
		if (token) headers.Authorization = `Bearer ${token}`;
		return auth.handler(
			new Request(`${origin}/api/auth${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			})
		);
	}
	async function signIn(password: string) {
		return post("/sign-in/email", {
			email: "owner@example.test",
			password,
		});
	}
	async function session(token: string) {
		const response = await auth.handler(
			new Request(`${origin}/api/auth/get-session`, {
				headers: { Authorization: `Bearer ${token}`, Origin: origin },
			})
		);
		return response.json();
	}
	return { post, signIn, session };
}

async function tokenOf(response: Response): Promise<string> {
	assert.equal(response.status, 200, await response.clone().text());
	return z.object({ token: z.string() }).parse(await response.json()).token;
}

test("changing a password checks the current one and the shared policy", async (t) => {
	const { post, signIn } = await changePasswordFixture(t);
	const token = await tokenOf(await signIn(startingPassword));
	const anonymous = await post("/change-password", {
		currentPassword: startingPassword,
		newPassword: changedPassword,
	});
	assert.equal(anonymous.status, 401);
	const wrong = await post(
		"/change-password",
		{
			currentPassword: "Not-the-password-1!",
			newPassword: changedPassword,
		},
		token
	);
	assert.equal(wrong.status, 400);
	assert.equal(
		errorSchema.parse(await wrong.json()).code,
		"INVALID_PASSWORD"
	);
	for (const [newPassword, code] of [
		["x".repeat((passwordSchema.minLength ?? 0) - 1), "PASSWORD_TOO_SHORT"],
		["x".repeat((passwordSchema.maxLength ?? 0) + 1), "PASSWORD_TOO_LONG"],
	] as const) {
		const rejected = await post(
			"/change-password",
			{ currentPassword: startingPassword, newPassword },
			token
		);
		assert.equal(rejected.status, 400);
		assert.equal(errorSchema.parse(await rejected.json()).code, code);
	}
	// Nothing changed: the starting password still signs in.
	await tokenOf(await signIn(startingPassword));
});

test("a changed password replaces the old one and can sign out other sessions", async (t) => {
	const { post, signIn, session } = await changePasswordFixture(t);
	const other = await tokenOf(await signIn(startingPassword));
	const current = await tokenOf(await signIn(startingPassword));
	const changed = await post(
		"/change-password",
		{
			currentPassword: startingPassword,
			newPassword: changedPassword,
			revokeOtherSessions: true,
		},
		current
	);
	const replacement = await tokenOf(changed);
	assert.equal(await session(other), null, "other sessions are signed out");
	assert.notEqual(await session(replacement), null);
	const old = await signIn(startingPassword);
	assert.equal(old.status, 401);
	await tokenOf(await signIn(changedPassword));
});
