import assert from "node:assert/strict";
import test from "node:test";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";
import { createAuth } from "../../src/worker/auth";
import { passwordSchema } from "../../src/contracts/auth";

test("password recovery follows its callback, enforces the shared policy, and replaces the credential once", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const origin = "http://localhost:4321";
	const auth = createAuth(
		testBindings({
			CORE_DB: f.binding,
			APP_URL: origin,
			APP_ENV: "local",
			EMAIL_TRANSPORT: "log",
			BETTER_AUTH_SECRET:
				"integration-secret-at-least-thirty-two-characters",
			PRODUCT_NAME: "Test",
		})
	);
	// Only the external password compromise lookup is replaced; auth and SQL remain real.
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0");
	});
	let resetUrl: string | undefined;
	t.mock.method(
		console,
		"log",
		(label: string, payload?: { url?: string }) => {
			if (label === "[email:log-only:url]") resetUrl = payload?.url;
		}
	);
	const callback = `${origin}/app/reset-password`;
	const headers = new Headers({ Origin: origin });
	await auth.api.requestPasswordReset({
		body: { email: "owner@example.test", redirectTo: callback },
		headers,
	});
	assert.ok(resetUrl);
	const redirected = await auth.handler(new Request(resetUrl));
	assert.equal(redirected.status, 302);
	const location = redirected.headers.get("Location");
	assert.ok(location);
	const url = new URL(location);
	assert.equal(url.pathname, "/app/reset-password");
	const token = url.searchParams.get("token");
	assert.ok(token);
	for (const password of [
		"x".repeat((passwordSchema.minLength ?? 0) - 1),
		"x".repeat((passwordSchema.maxLength ?? 0) + 1),
	])
		await assert.rejects(
			auth.api.resetPassword({
				headers,
				body: { token, newPassword: password },
			})
		);
	const password = "Recovered-credential-492873!";
	await auth.api.resetPassword({
		headers,
		body: { token, newPassword: password },
	});
	await assert.rejects(
		auth.api.resetPassword({
			headers,
			body: { token, newPassword: password },
		})
	);
	const signedIn = await auth.api.signInEmail({
		headers,
		body: { email: "owner@example.test", password },
	});
	assert.equal(signedIn.user.id, "owner");
});
