import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { migratedSqlite } from "../helpers/migrations";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { testBindings } from "../helpers/worker";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";

test("local bootstrap creates a usable admin credential and preserves it on rerun", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-admin-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const state = join(
		directory,
		".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
	);
	mkdirSync(state, { recursive: true });
	symlinkSync(
		fileURLToPath(new URL("../../scripts", import.meta.url)),
		join(directory, "scripts"),
		"dir"
	);
	writeFileSync(
		join(directory, ".env"),
		'BETTER_AUTH_SECRET="bootstrap-test-secret-at-least-thirty-two-characters"\nADMIN_EMAIL="ADMIN@example.test"\nAPP_URL="http://localhost:4321"\n'
	);
	const initial = migratedSqlite("core");
	const filename = join(state, "core.sqlite");
	writeFileSync(filename, initial.serialize());
	initial.close();
	const environment = { ...process.env };
	for (const key of ["ADMIN_EMAIL", "APP_URL"]) delete environment[key];
	function bootstrap() {
		const result = spawnSync(
			process.execPath,
			["scripts/create-admin-local.mjs"],
			{
				cwd: directory,
				env: environment,
				encoding: "utf8",
			}
		);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	}
	bootstrap();
	const passwordFile = join(directory, ".wrangler/.admin-password");
	const saved = readFileSync(passwordFile, "utf8");
	const credential = z
		.object({ email: z.string(), password: z.string() })
		.parse(JSON.parse(saved));
	const sqlite = new Database(filename);
	t.after(() => sqlite.close());
	const origin = "http://localhost:4321";
	const auth = createAuth(
		testBindings({
			CORE_DB: createSqliteD1(sqlite),
			APP_URL: origin,
			BETTER_AUTH_SECRET:
				"bootstrap-test-secret-at-least-thirty-two-characters",
			PRODUCT_NAME: "Test",
			EMAIL_TRANSPORT: "log",
		})
	);
	const signedIn = await auth.api.signInEmail({
		body: credential,
		headers: new Headers({ Origin: origin }),
	});
	assert.equal(signedIn.user.email, "admin@example.test");
	assert.equal(signedIn.user.role, "admin");
	assert.equal(signedIn.user.emailVerified, true);
	assert.match(bootstrap(), /credential password unchanged/);
	assert.equal(readFileSync(passwordFile, "utf8"), saved);
	writeFileSync(
		join(directory, ".env"),
		'ADMIN_EMAIL="dev@example.test"\nAPP_URL="http://dev.example.test"\n'
	);
	const status = spawnSync(process.execPath, ["scripts/dev-status.mjs"], {
		cwd: directory,
		env: {
			...environment,
			APP_URL: "http://shell.example.test",
		},
		encoding: "utf8",
	});
	assert.equal(status.status, 0, status.stderr);
	assert.match(status.stdout, /ADMIN_EMAIL\s+dev@example\.test/);
	assert.match(status.stdout, /APP_URL\s+http:\/\/shell\.example\.test/);
});

const bootstrapSecret = "bootstrap-secret-for-integration-tests";
const bootstrapOrigin = "https://app.example.test";
const bootstrapContext = {
	waitUntil() {},
	passThroughOnException() {},
	props: {},
};
const credentialResponseSchema = z.object({
	ok: z.literal(true),
	status: z.literal("bootstrapped"),
	credential: z.object({ email: z.string(), password: z.string() }),
});

// A production-shaped Worker without an email provider: the response mode
// must not need one, and the default email mode must still try to send.
function productionBootstrap(t: test.TestContext) {
	const sqlite = migratedSqlite("core");
	t.after(() => sqlite.close());
	const stored = new Map<string, string>();
	const kv = {
		async get(key: string) {
			return stored.get(key) ?? null;
		},
		async put(key: string, value: string) {
			stored.set(key, value);
		},
	};
	const env = testBindings({
		CORE_DB: createSqliteD1(sqlite),
		// SAFETY: bootstrap uses only string get and put on the fixture KV.
		CORE_KV: kv as KVNamespace,
		APP_URL: bootstrapOrigin,
		APP_ENV: "production",
		ADMIN_EMAIL: "Owner@Example.test",
		BOOTSTRAP_SECRET: bootstrapSecret,
		BETTER_AUTH_SECRET:
			"bootstrap-test-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "cloudflare",
		EMAIL_FROM: "noreply@example.test",
	});
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0");
	});
	function bootstrap(body: string | undefined, secret = bootstrapSecret) {
		const headers: Record<string, string> = {
			"x-bootstrap-secret": secret,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		return api.request(
			`${bootstrapOrigin}/internal/bootstrap-admin`,
			{
				method: "POST",
				headers,
				...(body === undefined ? {} : { body }),
			},
			env,
			bootstrapContext
		);
	}
	async function signIn(password: string) {
		return createAuth(env).api.signInEmail({
			body: { email: "owner@example.test", password },
			headers: new Headers({ Origin: bootstrapOrigin }),
		});
	}
	return { sqlite, env, stored, bootstrap, signIn };
}

test("bootstrap can return the first admin's password once when email cannot be sent", async (t) => {
	const { sqlite, stored, bootstrap, signIn } = productionBootstrap(t);
	assert.equal(
		(await bootstrap(JSON.stringify({ delivery: "response" }), "wrong"))
			.status,
		401
	);
	for (const body of [
		'{"delivery":"sms"}',
		'{"delivery":"response","extra":1}',
		"not json",
	]) {
		const rejected = await bootstrap(body);
		assert.equal(rejected.status, 400, body);
		assert.equal(rejected.headers.get("Cache-Control"), "no-store");
	}
	assert.equal(
		sqlite.prepare("select count(*) as count from auth_user").pluck().get(),
		0
	);
	const response = await bootstrap(JSON.stringify({ delivery: "response" }));
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const { credential } = credentialResponseSchema.parse(
		await response.json()
	);
	assert.equal(credential.email, "owner@example.test");
	const signedIn = await signIn(credential.password);
	assert.equal(signedIn.user.role, "admin");
	assert.equal(signedIn.user.emailVerified, true);
	const accounts = JSON.stringify(
		sqlite.prepare("select * from auth_account").all()
	);
	assert.ok(
		!accounts.includes(credential.password),
		"only the hash is stored"
	);
	assert.ok(stored.has("bootstrap:admin:owner@example.test"));
	// One-shot: the secret cannot mint a second password.
	const again = await bootstrap(JSON.stringify({ delivery: "response" }));
	assert.equal(again.status, 409);
	assert.equal(
		z
			.object({ credential: z.unknown().optional() })
			.parse(await again.json()).credential,
		undefined
	);
});

test("bootstrap response mode replaces a pre-existing credential and ends its sessions", async (t) => {
	const { sqlite, bootstrap, signIn, env } = productionBootstrap(t);
	// Someone registered ADMIN_EMAIL before the owner bootstrapped.
	const squatterPassword = "Squatter-password-123!";
	await createAuth({ ...env, AUTH_SIGNUP_MODE: "open" }).api.signUpEmail({
		body: {
			email: "owner@example.test",
			name: "Squatter",
			password: squatterPassword,
		},
	});
	const squatter = await signIn(squatterPassword);
	const response = await bootstrap(JSON.stringify({ delivery: "response" }));
	assert.equal(response.status, 200, await response.clone().text());
	const { credential } = credentialResponseSchema.parse(
		await response.json()
	);
	await assert.rejects(() => signIn(squatterPassword));
	const session = await createAuth(env).api.getSession({
		headers: new Headers({ Authorization: `Bearer ${squatter.token}` }),
	});
	assert.equal(session, null, "the earlier session was revoked");
	const owner = await signIn(credential.password);
	assert.equal(owner.user.role, "admin");
	assert.equal(
		sqlite.prepare("select count(*) as count from auth_user").pluck().get(),
		1
	);
});

test("bootstrap without a body still emails a reset link, and refuses when email cannot be sent", async (t) => {
	const { sqlite, bootstrap, stored, env } = productionBootstrap(t);
	// Better Auth swallows send failures, so bootstrap checks configuration
	// first instead of reporting a success that burns its single use.
	const refused = await bootstrap(undefined);
	assert.equal(refused.status, 503);
	assert.deepEqual(await refused.json(), {
		ok: false,
		status: "email_unavailable",
	});
	assert.equal(stored.size, 0);
	assert.equal(
		sqlite.prepare("select count(*) as count from auth_user").pluck().get(),
		0
	);
	const sent: string[] = [];
	env.EMAIL_FROM = "noreply@mail.your-company.com";
	env.SEND_EMAIL = {
		async send(message: unknown) {
			sent.push(z.object({ to: z.string() }).parse(message).to);
			return { messageId: "message-1" };
		},
	};
	const response = await bootstrap(undefined);
	assert.equal(response.status, 200, await response.clone().text());
	assert.deepEqual(await response.json(), {
		ok: true,
		status: "bootstrapped",
	});
	assert.deepEqual(sent, ["owner@example.test"]);
});
