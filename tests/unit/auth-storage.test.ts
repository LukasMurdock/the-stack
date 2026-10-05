import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
	createAuthStorage,
	cleanupAuthStorage,
} from "../../src/worker/auth-storage";
import { createAuth, type AuthEnv } from "../../src/worker/auth";

function fixture() {
	const sqlite = new Database(":memory:");
	for (const name of [
		"0000_left_shape.sql",
		"0001_auth-secondary-storage.sql",
	]) {
		sqlite.exec(
			readFileSync(
				new URL(
					`../../src/bindings/d1/core/drizzle/${name}`,
					import.meta.url
				),
				"utf8"
			)
		);
	}
	function prepare(sql: string, values: unknown[] = []) {
		return {
			bind(...values: unknown[]) {
				return prepare(sql, values);
			},
			async first(column?: string) {
				const row = sqlite.prepare(sql).get(...values) as
					| Record<string, unknown>
					| undefined;
				return row ? (column ? row[column] : row) : null;
			},
			async run() {
				const result = sqlite.prepare(sql).run(...values);
				return {
					success: true,
					results: [],
					meta: { changes: result.changes },
				};
			},
			async all() {
				return {
					success: true,
					results: sqlite.prepare(sql).all(...values),
				};
			},
			async raw() {
				return sqlite
					.prepare(sql)
					.raw()
					.all(...values);
			},
		};
	}
	const db = { prepare } as unknown as D1Database;
	return { sqlite, db, storage: createAuthStorage(db) };
}

test("auth storage preserves values, replaces TTLs, and excludes expired records", async (t) => {
	const { sqlite, storage, db } = fixture();
	t.after(() => sqlite.close());
	assert.equal(await storage.get("missing"), null);
	await storage.set("session", '{"token":"value"}', 60);
	assert.equal(await storage.get("session"), '{"token":"value"}');
	await storage.set("session", "replacement");
	assert.equal(
		sqlite.prepare("SELECT expires_at FROM auth_storage").get().expires_at,
		null
	);
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- This is the key-value adapter, not a Drizzle table deletion.
	await storage.delete("session");
	assert.equal(await storage.get("session"), null);
	await storage.set("expired", "secret", 60);
	sqlite.exec("UPDATE auth_storage SET expires_at = unixepoch() - 1");
	assert.equal(await storage.get("expired"), null);
	await cleanupAuthStorage(db);
	assert.equal(
		sqlite.prepare("SELECT count(*) AS n FROM auth_storage").get().n,
		0
	);
});

test("only one caller consumes a verification token, and expired tokens cannot be consumed", async (t) => {
	const { sqlite, storage } = fixture();
	t.after(() => sqlite.close());
	await storage.set("verification:reset", "secret", 60);
	const results = await Promise.all(
		Array.from({ length: 20 }, () =>
			storage.getAndDelete("verification:reset")
		)
	);
	assert.equal(results.filter((value) => value === "secret").length, 1);
	assert.equal(results.filter((value) => value === null).length, 19);
	await storage.set("expired", "secret", 60);
	sqlite.exec("UPDATE auth_storage SET expires_at = unixepoch()");
	assert.equal(await storage.getAndDelete("expired"), null);
	assert.equal(
		sqlite.prepare("SELECT count(*) AS n FROM auth_storage").get().n,
		0
	);
});

test("concurrent increments do not lose counts or extend the window, and expired windows reset", async (t) => {
	const { sqlite, storage } = fixture();
	t.after(() => sqlite.close());
	assert.equal(await storage.increment("rate-limit", 60), 1);
	const expiry = sqlite
		.prepare("SELECT expires_at FROM auth_storage")
		.get().expires_at;
	const results = await Promise.all(
		Array.from({ length: 20 }, () => storage.increment("rate-limit", 600))
	);
	assert.deepEqual(
		results,
		Array.from({ length: 20 }, (_, i) => i + 2)
	);
	assert.equal(
		sqlite.prepare("SELECT expires_at FROM auth_storage").get().expires_at,
		expiry
	);
	assert.equal(await storage.get("rate-limit"), "21");
	sqlite.exec("UPDATE auth_storage SET expires_at = unixepoch() - 1");
	assert.equal(await storage.increment("rate-limit", 600), 1);
	assert.ok(
		sqlite.prepare("SELECT expires_at FROM auth_storage").get().expires_at >
			expiry
	);
	for (const ttl of [0, -1, 1.5, Infinity, NaN]) {
		await assert.rejects(
			storage.increment("invalid", ttl),
			/positive integer/
		);
		await assert.rejects(
			storage.set("invalid", "value", ttl),
			/positive integer/
		);
	}
});

test("Better Auth 1.7 signs up, reads sessions, and revokes them using D1", async (t) => {
	const { sqlite, db } = fixture();
	t.after(() => sqlite.close());
	const originalFetch = globalThis.fetch;
	t.mock.method(
		globalThis,
		"fetch",
		(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (new URL(url).hostname === "api.pwnedpasswords.com")
				return Promise.resolve(new Response(""));
			return originalFetch(input, init);
		}
	);
	const auth = createAuth({
		CORE_DB: db,
		BETTER_AUTH_SECRET:
			"test-auth-secret-that-is-at-least-32-characters-long",
		AUTH_SIGNUP_MODE: "open",
		PRODUCT_NAME: "Test",
		APP_ENV: "test",
		EMAIL_TRANSPORT: "log",
	} as AuthEnv);
	const response = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Test",
				email: "test@example.com",
				password: "Valid-password-123!",
			}),
		})
	);
	assert.equal(response.status, 200, await response.clone().text());
	const result = (await response.json()) as { token: string };
	const headers = { Authorization: `Bearer ${result.token}` };
	const session = await auth.handler(
		new Request("http://localhost:3000/api/auth/get-session", { headers })
	);
	assert.equal(session.status, 200);
	assert.ok(((await session.json()) as { session: unknown }).session);
	const signOut = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-out", {
			method: "POST",
			headers,
		})
	);
	assert.equal(signOut.status, 200);
	const revoked = await auth.handler(
		new Request("http://localhost:3000/api/auth/get-session", { headers })
	);
	assert.equal(await revoked.json(), null);
});
