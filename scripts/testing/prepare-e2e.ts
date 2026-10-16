// Prepares one browser run: a Worker config, freshly migrated and seeded D1
// state, and a build, all under .wrangler/e2e/<port>. Playwright's webServer
// runs it; STACK_E2E_PORT selects the port, STACK_E2E_REBUILD=1 forces both
// the fixture state and the build to be recreated.

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
	type Command,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "../lib/cli.ts";
import {
	buildFingerprint,
	e2ePaths,
	e2ePortFromEnv,
	stampMatches,
	withCheckoutLock,
} from "./e2e.ts";

export const PREPARE_E2E_USAGE = `Usage: node scripts/testing/prepare-e2e.ts

Takes no arguments. Environment:
  STACK_E2E_PORT     Port the run belongs to (1024-65535, default 4322).
  STACK_E2E_REBUILD  "1" recreates the fixture state and the build.`;

const FIXTURE_USERS = ["owner", "viewer", "admin"] as const;
const FIXTURE_PASSWORD = "Browser-test-password-123!";

export type PrepareE2EOptions = {
	readonly port: number;
	readonly rebuild: boolean;
};

export function parsePrepareE2EOptions(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>
): Command<PrepareE2EOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	let port: number;
	try {
		port = e2ePortFromEnv(env);
	} catch (error: unknown) {
		throw new UsageError(
			error instanceof Error ? error.message : String(error)
		);
	}
	const rebuild = env.STACK_E2E_REBUILD ?? "";
	if (rebuild !== "" && rebuild !== "0" && rebuild !== "1")
		throw new UsageError(
			`STACK_E2E_REBUILD must be 1 or unset, got "${rebuild}".`
		);
	return { kind: "run", options: { port, rebuild: rebuild === "1" } };
}

type E2EPaths = ReturnType<typeof e2ePaths>;

// The Worker config for this port. Its JSON is part of the fingerprint.
function writeWorkerConfig(port: number, paths: E2EPaths): string {
	const { triggers: _crons, ...base } = localCloudflare;
	const config = {
		...base,
		// Wrangler registers local Workers by name in a machine-wide registry.
		name: `the-stack-e2e-${port}`,
		main: path.resolve("src/worker.ts"),
		assets: { ...base.assets, directory: paths.outDir },
		vars: {
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
		},
		d1_databases: base.d1_databases.map((database) => ({
			...database,
			migrations_dir: path.resolve(database.migrations_dir),
		})),
	};
	const json = JSON.stringify(config, null, 2);
	writeFileSync(paths.config, json);
	return json;
}

function migrate(paths: E2EPaths): void {
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
}

// Returns whether this file was CORE_DB (the one with auth tables).
function seedUsers(file: string, passwordHash: string): boolean {
	const db = new Database(file);
	try {
		const authTable = db
			.prepare("select name from sqlite_master where name = 'auth_user'")
			.get();
		if (authTable === undefined) return false;
		for (const id of FIXTURE_USERS) {
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
			).run(`${id}-account`, id, id, passwordHash, Date.now());
		}
		return true;
	} finally {
		db.close();
	}
}

// Each run starts from freshly migrated, seeded D1 state. Migrating takes two
// Wrangler processes, so keep a pristine copy and restore it when unchanged.
async function prepareState(
	paths: E2EPaths,
	stamp: { readonly fingerprint: string | null; readonly rebuild: boolean }
): Promise<void> {
	if (
		stampMatches(paths.stateStamp, stamp.fingerprint, stamp) &&
		existsSync(paths.stateTemplate)
	) {
		cpSync(paths.stateTemplate, paths.state, { recursive: true });
		return;
	}
	rmSync(paths.stateStamp, { force: true });
	migrate(paths);
	const passwordHash = await hashPassword(FIXTURE_PASSWORD);
	const sqliteFiles = readdirSync(paths.state, {
		recursive: true,
		encoding: "utf8",
	}).filter((name) => name.endsWith(".sqlite"));
	let seeded = false;
	for (const name of sqliteFiles)
		if (seedUsers(path.join(paths.state, name), passwordHash))
			seeded = true;
	if (!seeded) throw new Error("Browser fixture CORE_DB was not found.");
	rmSync(paths.stateTemplate, { recursive: true, force: true });
	cpSync(paths.state, paths.stateTemplate, { recursive: true });
	writeFileSync(
		paths.stateStamp,
		JSON.stringify({ fingerprint: stamp.fingerprint })
	);
}

// Reuse this port's previous build when its inputs are unchanged.
function prepareBuild(
	port: number,
	paths: E2EPaths,
	stamp: { readonly fingerprint: string | null; readonly rebuild: boolean }
): void {
	if (stampMatches(paths.buildStamp, stamp.fingerprint, stamp)) {
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
	writeFileSync(
		paths.buildStamp,
		JSON.stringify({ fingerprint: stamp.fingerprint })
	);
}

// This directory is exclusively owned by one browser run on this port. Normal
// local D1 state, .env and production resources are never read or reset.
export async function prepareE2E(options: PrepareE2EOptions): Promise<void> {
	const paths = e2ePaths(options.port);
	rmSync(paths.state, { recursive: true, force: true });
	mkdirSync(paths.directory, { recursive: true });
	const configJson = writeWorkerConfig(options.port, paths);
	// The fingerprint hashes file contents, so edits, new files and branch
	// switches invalidate both the fixture state and the build.
	const stamp = {
		fingerprint: buildFingerprint(process.cwd(), configJson),
		rebuild: options.rebuild,
	};
	await prepareState(paths, stamp);
	await withCheckoutLock(process.cwd(), () =>
		prepareBuild(options.port, paths, stamp)
	);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: PREPARE_E2E_USAGE,
		parse: () => parsePrepareE2EOptions(process.argv.slice(2), process.env),
		run: prepareE2E,
	});
