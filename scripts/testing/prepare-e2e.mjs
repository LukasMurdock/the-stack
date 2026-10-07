import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { hashPassword } from "better-auth/crypto";
import ts from "typescript";

// This directory is exclusively owned by the browser suite. Normal local D1
// state, .dev.vars and production resources are never read or reset.
const directory = path.resolve(".wrangler/e2e");
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const parsed = ts.parseConfigFileTextToJson(
	"wrangler.json",
	readFileSync("wrangler.json", "utf8")
);
if (parsed.error) throw new Error("Invalid Wrangler configuration.");
const config = parsed.config;
delete config.env;
delete config.triggers;
config.name = "the-stack-e2e";
config.main = path.resolve("src/worker.ts");
config.assets.directory = path.resolve("dist");
config.vars = {
	PRODUCT_NAME: "The Stack",
	APP_ENV: "test",
	APP_URL: "http://localhost:4322",
	ADMIN_EMAIL: "owner@example.test",
	EMAIL_FROM: "noreply@localhost.test",
	EMAIL_TRANSPORT: "log",
	AUTH_SIGNUP_MODE: "invite_only",
	TURRET_MODE: "full",
	TURRET_SIGNING_KEY: "browser-test-upload-signing-key",
	BETTER_AUTH_SECRET: "browser-test-secret-not-for-real-environments",
};
for (const database of config.d1_databases)
	database.migrations_dir = path.resolve(database.migrations_dir);
writeFileSync(
	path.join(directory, "wrangler.json"),
	JSON.stringify(config, null, 2)
);
for (const binding of ["CORE_DB", "TURRET_DB"])
	execFileSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			binding,
			"--local",
			"--config",
			path.join(directory, "wrangler.json"),
			"--persist-to",
			path.join(directory, "state"),
		],
		{ stdio: "inherit" }
	);
const password = await hashPassword("Browser-test-password-123!");
const sqlitePaths = readdirSync(path.join(directory, "state"), {
	recursive: true,
}).filter((name) => typeof name === "string" && name.endsWith(".sqlite"));
let seeded = false;
for (const name of sqlitePaths) {
	const db = new Database(path.join(directory, "state", name));
	try {
		if (
			!db
				.prepare(
					"select name from sqlite_master where name = 'auth_user'"
				)
				.get()
		)
			continue;
		for (const id of ["owner", "viewer", "admin"]) {
			db.prepare(
				"insert into auth_user (id, name, email, email_verified, role) values (?, ?, ?, 1, ?)"
			).run(
				id,
				id,
				`${id}@example.test`,
				id === "admin" ? "admin" : "user"
			);
			db.prepare(
				"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, ?, 'credential', ?, ?, ?)"
			).run(`${id}-account`, id, id, password, Date.now());
		}
		seeded = true;
	} finally {
		db.close();
	}
}
if (!seeded) throw new Error("Browser fixture CORE_DB was not found.");
