import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import worker, { type WorkerEnv } from "../../src/worker/index";
import { fakeKv } from "../helpers/fake-kv";
import { productFixture } from "../helpers/product";
import { testBindings, untracedExecutionContext } from "../helpers/worker";

// The Worker entry exactly as Cloudflare calls it in production, with each
// secret a Secrets Store binding rather than a string.

const origin = "http://localhost:4321";
const AUTH_SECRET = "store-backed-auth-secret-at-least-thirty-two-chars";
const PASSWORD = "Valid-test-password-123!";

function storeSecret(value: string): SecretsStoreSecret {
	return { get: () => Promise.resolve(value) };
}

function deletedStoreSecret(name: string): SecretsStoreSecret {
	return {
		get: () => Promise.reject(new Error(`Secret "${name}" not found`)),
	};
}

function quietErrors(t: TestContext): unknown[][] {
	const calls: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => {
		calls.push(args);
	});
	return calls;
}

function fixtureEnv(
	t: TestContext,
	secrets: Partial<
		Pick<WorkerEnv, "BETTER_AUTH_SECRET" | "TURRET_SIGNING_KEY">
	>
): WorkerEnv {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	return {
		...testBindings({
			APP_URL: origin,
			APP_ENV: "production",
			PRODUCT_NAME: "Test",
			EMAIL_TRANSPORT: "log",
			EMAIL_FROM: "noreply@example.test",
			TURRET_MODE: "full",
			CORE_DB: f.binding,
			CORE_KV: fakeKv().binding,
		}),
		...secrets,
	};
}

const healthSchema = z.object({
	turret: z.object({ effectiveMode: z.string() }),
});
const readinessSchema = z.object({
	ok: z.boolean(),
	secrets: z.object({ missingRequired: z.array(z.string()) }),
});

test("health and readiness see Store-bound secrets as resolved values", async (t) => {
	const errors = quietErrors(t);
	const env = fixtureEnv(t, {
		BETTER_AUTH_SECRET: storeSecret(AUTH_SECRET),
		TURRET_SIGNING_KEY: storeSecret("store-turret-signing-key"),
	});
	const health = await worker.fetch(
		new Request(`${origin}/api/health`),
		env,
		untracedExecutionContext()
	);
	assert.equal(health.status, 200);
	assert.equal(
		healthSchema.parse(await health.json()).turret.effectiveMode,
		"full"
	);
	const readiness = await worker.fetch(
		new Request(`${origin}/api/readiness`),
		env,
		untracedExecutionContext()
	);
	assert.equal(readiness.status, 200);
	assert.deepEqual(readinessSchema.parse(await readiness.json()), {
		ok: true,
		secrets: { missingRequired: [] },
	});
	assert.deepEqual(errors, []);
});

test("a deleted Store secret degrades an optional feature and fails readiness when required", async (t) => {
	const errors = quietErrors(t);
	const env = fixtureEnv(t, {
		BETTER_AUTH_SECRET: deletedStoreSecret("BETTER_AUTH_SECRET"),
		TURRET_SIGNING_KEY: deletedStoreSecret("TURRET_SIGNING_KEY"),
	});
	const health = await worker.fetch(
		new Request(`${origin}/api/health`),
		env,
		untracedExecutionContext()
	);
	assert.equal(health.status, 200);
	assert.equal(
		healthSchema.parse(await health.json()).turret.effectiveMode,
		"basic"
	);
	const readiness = await worker.fetch(
		new Request(`${origin}/api/readiness`),
		env,
		untracedExecutionContext()
	);
	assert.equal(readiness.status, 503);
	assert.deepEqual(
		readinessSchema.parse(await readiness.json()).secrets.missingRequired,
		["BETTER_AUTH_SECRET"]
	);
	const signIn = await worker.fetch(
		new Request(`${origin}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({
				email: "owner@example.test",
				password: PASSWORD,
			}),
		}),
		env,
		untracedExecutionContext()
	);
	assert.equal(signIn.status, 500);
	assert.match(
		JSON.stringify(errors),
		/BETTER_AUTH_SECRET is not configured/
	);
});

test("Better Auth signs and verifies sessions with the Store secret across requests", async (t) => {
	const env = fixtureEnv(t, { BETTER_AUTH_SECRET: storeSecret(AUTH_SECRET) });
	const database = env.CORE_DB;
	await database
		.prepare(
			"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, ?, 'credential', ?, ?, ?)"
		)
		.bind(
			"owner-account",
			"owner",
			"owner",
			await hashPassword(PASSWORD),
			Date.now()
		)
		.run();
	const signIn = await worker.fetch(
		new Request(`${origin}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin },
			body: JSON.stringify({
				email: "owner@example.test",
				password: PASSWORD,
			}),
		}),
		env,
		untracedExecutionContext()
	);
	assert.equal(signIn.status, 200);
	const cookie = signIn.headers.get("set-cookie")?.split(";")[0];
	assert.ok(cookie, "sign-in sets the session cookie");
	const session = await worker.fetch(
		new Request(`${origin}/api/auth/get-session`, {
			headers: { Cookie: cookie, Origin: origin },
		}),
		env,
		untracedExecutionContext()
	);
	assert.equal(session.status, 200);
	const body = z
		.object({ user: z.object({ email: z.string() }) })
		.parse(await session.json());
	assert.equal(body.user.email, "owner@example.test");
	// A different secret cannot verify the cookie the Store secret signed.
	const rotated = await worker.fetch(
		new Request(`${origin}/api/auth/get-session`, {
			headers: { Cookie: cookie, Origin: origin },
		}),
		{
			...env,
			BETTER_AUTH_SECRET: storeSecret(`${AUTH_SECRET}-rotated`),
		},
		untracedExecutionContext()
	);
	assert.equal(await rotated.text(), "null");
});
