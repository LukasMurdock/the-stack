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
		join(directory, ".dev.vars"),
		'BETTER_AUTH_SECRET="bootstrap-test-secret-at-least-thirty-two-characters"\n'
	);
	writeFileSync(
		join(directory, "wrangler.json"),
		JSON.stringify({
			vars: {
				APP_URL: "http://localhost:4321",
				ADMIN_EMAIL: "ADMIN@example.test",
			},
		})
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
		join(directory, ".dev.vars"),
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
