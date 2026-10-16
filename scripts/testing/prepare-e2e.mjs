import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { hashPassword } from "better-auth/crypto";
import { localCloudflare } from "../../config/cloudflare.mjs";
import {
	buildFingerprint,
	defaultE2EPort,
	e2ePaths,
	parsePort,
	stampMatches,
	withCheckoutLock,
} from "./e2e.mjs";

// This directory is exclusively owned by one browser run on this port. Normal
// local D1 state, .env and production resources are never read or reset.
const port = parsePort(process.env.STACK_E2E_PORT ?? defaultE2EPort);
const paths = e2ePaths(port);
rmSync(paths.state, { recursive: true, force: true });
mkdirSync(paths.directory, { recursive: true });
const config = structuredClone(localCloudflare);
delete config.triggers;
// Wrangler registers local Workers by name in a machine-wide dev registry.
config.name = `the-stack-e2e-${port}`;
config.main = path.resolve("src/worker.ts");
config.assets.directory = paths.outDir;
config.vars = {
	PRODUCT_NAME: "The Stack",
	APP_ENV: "test",
	APP_URL: `http://localhost:${port}`,
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
const configJson = JSON.stringify(config, null, 2);
writeFileSync(paths.config, configJson);
// Inputs to both the migrated fixture state and the build. The fingerprint
// hashes file contents, so edits, new files and branch switches invalidate
// them; STACK_E2E_REBUILD=1 forces both to be recreated.
const fingerprint = buildFingerprint(process.cwd(), configJson);
const stamp = JSON.stringify({ fingerprint });

// Each run starts from freshly migrated, seeded D1 state. Migrating takes two
// Wrangler processes, so keep a pristine copy and restore it when unchanged.
if (
	stampMatches(paths.stateStamp, fingerprint) &&
	existsSync(paths.stateTemplate)
) {
	cpSync(paths.stateTemplate, paths.state, { recursive: true });
} else {
	rmSync(paths.stateStamp, { force: true });
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
				paths.config,
				"--persist-to",
				paths.state,
			],
			{ stdio: "inherit" }
		);
	const password = await hashPassword("Browser-test-password-123!");
	const sqlitePaths = readdirSync(paths.state, {
		recursive: true,
	}).filter((name) => typeof name === "string" && name.endsWith(".sqlite"));
	let seeded = false;
	for (const name of sqlitePaths) {
		const db = new Database(path.join(paths.state, name));
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
	rmSync(paths.stateTemplate, { recursive: true, force: true });
	cpSync(paths.state, paths.stateTemplate, { recursive: true });
	writeFileSync(paths.stateStamp, stamp);
}

// Reuse this port's previous build when its inputs are unchanged.
await withCheckoutLock(process.cwd(), () => {
	if (stampMatches(paths.buildStamp, fingerprint)) {
		process.stderr.write(
			`Reusing E2E build in ${path.relative(process.cwd(), paths.outDir)} (inputs unchanged).\n`
		);
		return;
	}
	execFileSync("pnpm", ["exec", "astro", "build"], {
		stdio: "inherit",
		env: { ...process.env, STACK_E2E: "1", STACK_E2E_PORT: String(port) },
	});
	// Void stashes Astro's preview pointer after each build; keep this run's
	// copy so another build in the checkout cannot redirect this preview.
	copyFileSync(".void/preview-deploy-config.json", paths.deployConfig);
	writeFileSync(paths.buildStamp, stamp);
});
