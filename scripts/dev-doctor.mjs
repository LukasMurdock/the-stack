import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadLocalEnv } from "./local-env.mjs";

/** @param {string} message */
function ok(message) {
	process.stdout.write(`OK   ${message}\n`);
}

/** @param {string} message */
function warn(message) {
	process.stdout.write(`WARN ${message}\n`);
}

/** @param {string} message */
function fail(message) {
	process.stdout.write(`FAIL ${message}\n`);
}

/** @param {unknown} error */
function describe(error) {
	return error instanceof Error
		? error.message.split("\n")[0]
		: String(error);
}

const cwd = process.cwd();
const devVarsPath = path.resolve(cwd, ".env");

let failed = false;

if (!fs.existsSync(devVarsPath)) {
	fail("Missing .env. Run: pnpm local:setup");
	failed = true;
} else {
	ok("Found .env");
	const parsed = loadLocalEnv();
	if (parsed.error) {
		fail(`Could not parse .env: ${parsed.error.message}`);
		failed = true;
	} else {
		const required = ["BETTER_AUTH_SECRET", "APP_URL", "ADMIN_EMAIL"];
		for (const key of required) {
			const value = process.env[key];
			if (!value || value === "replace-me") {
				fail(`Missing required env var: ${key}`);
				failed = true;
			} else {
				ok(`Configured ${key}`);
			}
		}
		for (const key of [
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"BOOTSTRAP_SECRET",
			"TURRET_SIGNING_KEY",
		]) {
			if (process.env[key] === "replace-me") {
				fail(
					`${key} still uses replace-me. Set it to an empty string to disable it locally, or configure a real value.`
				);
				failed = true;
			}
		}

		if (process.env.APP_URL) {
			try {
				const appUrl = new URL(process.env.APP_URL);
				if (
					appUrl.protocol !== "http:" &&
					appUrl.protocol !== "https:"
				) {
					fail("APP_URL must use http or https");
					failed = true;
				} else {
					ok(`APP_URL is valid (${appUrl.origin})`);
				}
			} catch {
				// Reporting the bad value is this check's purpose.
				fail(`APP_URL is not a valid URL: ${process.env.APP_URL}`);
				failed = true;
			}
		}

		if (
			!process.env.TURRET_SIGNING_KEY ||
			process.env.TURRET_SIGNING_KEY === "replace-me"
		) {
			warn(
				"Turret ingest mode: basic (set TURRET_SIGNING_KEY for full ingest)"
			);
		} else {
			ok("Turret ingest mode: full");
		}

		const turretMode = (process.env.TURRET_MODE ?? "full")
			.trim()
			.toLowerCase();
		if (
			turretMode !== "off" &&
			turretMode !== "basic" &&
			turretMode !== "full"
		) {
			fail(
				`Invalid TURRET_MODE: ${process.env.TURRET_MODE} (expected off, basic, or full)`
			);
			failed = true;
		} else {
			ok(`Turret mode: ${turretMode}`);
		}

		const signupMode = (process.env.AUTH_SIGNUP_MODE ?? "invite_only")
			.trim()
			.toLowerCase();
		if (signupMode === "invite_only" || signupMode === "open") {
			ok(`Auth signup mode: ${signupMode}`);
		} else {
			fail(
				`Invalid AUTH_SIGNUP_MODE: ${process.env.AUTH_SIGNUP_MODE} (expected invite_only or open)`
			);
			failed = true;
		}
	}
}

try {
	const nodeVersion = execFileSync("node", ["-v"], {
		encoding: "utf8",
	}).trim();
	ok(`Node available (${nodeVersion})`);
} catch (error) {
	// Reported as a failed check; the doctor keeps checking the rest.
	fail(`Node is not available in PATH (${describe(error)})`);
	failed = true;
}

try {
	const voidVersion = execFileSync("pnpm", ["exec", "void", "--version"], {
		encoding: "utf8",
	}).trim();
	ok(`Void available (${voidVersion})`);
} catch (error) {
	fail(
		`Void not available via pnpm exec (install dependencies with pnpm install): ${describe(error)}`
	);
	failed = true;
}

const adminPasswordPath = path.resolve(cwd, ".wrangler/.admin-password");
if (fs.existsSync(adminPasswordPath)) {
	ok("Admin credential file present (.wrangler/.admin-password)");
} else {
	warn(
		"Admin credential file missing. Run: pnpm local:setup (or follow Getting Started to recover a lost password)."
	);
}

if (failed) {
	process.exit(1);
}
