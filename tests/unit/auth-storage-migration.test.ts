import { readSqlRow } from "../helpers/sqlite-d1";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("KV transfer preserves sessions, quoting and expiry, skips bootstrap, and retains existing D1 records", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "auth-migration-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const expiry = Math.floor(Date.now() / 1000) + 3600;
	const records = [
		{
			name: "session-token",
			expiration: expiry,
			value: JSON.stringify({
				session: { token: "session-token" },
				user: { id: "user" },
			}),
		},
		{
			name: "active-sessions-user",
			expiration: expiry,
			value: '[{"token":"session-token"}]',
		},
		{
			name: "verification:quote's",
			expiration: expiry,
			value: "value's\nsecond line",
		},
		{ name: "no-expiry", value: "retained forever" },
		{ name: "bootstrap:admin:test@example.com", value: "bootstrap marker" },
		{ name: "expired", expiration: 1, value: "expired" },
		{ name: "existing", value: "old KV value" },
	];
	writeFileSync(join(directory, "records.json"), JSON.stringify(records));
	// Stub just the remote CLI boundary; execute its generated SQL against SQLite.
	writeFileSync(
		join(directory, "pnpm"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = __dirname;
const args = process.argv.slice(2);
const records = JSON.parse(fs.readFileSync(path.join(directory, "records.json"), "utf8"));
if (args[2] === "kv" && args[4] === "list") {
  process.stdout.write(JSON.stringify(records.map(({ name, expiration }) => ({ name, expiration }))));
} else if (args[2] === "kv" && args[4] === "get") {
  process.stdout.write(records.find(record => record.name === args[5]).value);
} else if (args.includes("--file")) {
  fs.appendFileSync(path.join(directory, "output.sql"), fs.readFileSync(args[args.indexOf("--file") + 1], "utf8") + "\\n");
} else if (!args.includes("--command")) {
  process.exit(1);
}
`,
		{ mode: 0o700 }
	);
	const output = execFileSync(
		process.execPath,
		[
			"scripts/migrate-auth-storage.mjs",
			"--remote",
			"--env",
			"production",
			"--writes-paused",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}${delimiter}${process.env.PATH}`,
			},
		}
	);
	assert.ok(!output.includes("session-token"));
	const sqlite = new Database(":memory:");
	t.after(() => sqlite.close());
	sqlite.exec(
		readFileSync(
			new URL(
				"../../src/bindings/d1/core/drizzle/0001_auth-secondary-storage.sql",
				import.meta.url
			),
			"utf8"
		)
	);
	sqlite
		.prepare("INSERT INTO auth_storage VALUES (?, ?, NULL)")
		.run("existing", "current D1 value");
	sqlite.exec(readFileSync(join(directory, "output.sql"), "utf8"));
	const rows = sqlite
		.prepare("SELECT key, value, expires_at FROM auth_storage ORDER BY key")
		.all();
	assert.equal(rows.length, 5);
	for (const record of records.filter(
		(record) =>
			!["existing", "expired"].includes(record.name) &&
			!record.name.startsWith("bootstrap:")
	)) {
		assert.deepEqual(
			sqlite
				.prepare(
					"SELECT value, expires_at FROM auth_storage WHERE key = ?"
				)
				.get(record.name),
			{ value: record.value, expires_at: record.expiration ?? null }
		);
	}
	assert.equal(
		readSqlRow(
			sqlite,
			"SELECT value FROM auth_storage WHERE key = 'existing'"
		).value,
		"current D1 value"
	);
	// A retry before cutover is safe and does not replace destination records.
	sqlite.exec(readFileSync(join(directory, "output.sql"), "utf8"));
	assert.equal(
		readSqlRow(sqlite, "SELECT count(*) AS n FROM auth_storage").n,
		5
	);
});
