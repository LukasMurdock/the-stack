import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

function ok(message) {
	process.stdout.write(`OK   ${message}\n`);
}

function warn(message) {
	process.stdout.write(`WARN ${message}\n`);
}

function fail(message) {
	process.stdout.write(`FAIL ${message}\n`);
}

const cwd = process.cwd();
const devVarsPath = path.resolve(cwd, ".dev.vars");

let failed = false;

if (!fs.existsSync(devVarsPath)) {
	fail("Missing .dev.vars. Run: cp .dev.vars.example .dev.vars");
	failed = true;
} else {
	ok("Found .dev.vars");
	const parsed = dotenv.config({ path: devVarsPath, quiet: true });
	if (parsed.error) {
		fail(`Could not parse .dev.vars: ${parsed.error.message}`);
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
				fail("APP_URL is not a valid URL");
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
} catch {
	fail("Node is not available in PATH");
	failed = true;
}

try {
	const wranglerVersion = execFileSync("npx", ["wrangler", "--version"], {
		encoding: "utf8",
	}).trim();
	ok(`Wrangler available (${wranglerVersion})`);
} catch {
	warn(
		"Wrangler not available via npx (install dependencies with npm install)"
	);
}

const adminPasswordPath = path.resolve(cwd, ".wrangler/.admin-password");
if (fs.existsSync(adminPasswordPath)) {
	ok("Admin credential file present (.wrangler/.admin-password)");
} else {
	warn("Admin credential file missing. Run: just admin-create");
}

if (failed) {
	process.exit(1);
}
