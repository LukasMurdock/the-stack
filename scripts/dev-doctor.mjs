import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
	deploymentCloudflare,
	localCloudflare,
} from "../config/cloudflare.mjs";
import {
	EMAIL_DEPENDENT_FEATURES,
	describeEmailDelivery,
} from "../src/contracts/email-delivery.ts";
import {
	featureFlags,
	flagRegistryProblems,
} from "../src/contracts/feature-flags.ts";
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

// Email is optional, so these only warn. Production secrets and the
// Void-provisioned SEND_EMAIL binding are not visible here; this catches the
// configuration mistakes that can be seen locally.
// .env overrides the local Worker's configured vars, as in `pnpm dev`.
const localVars = localCloudflare.vars;
const localEmail = describeEmailDelivery({
	appEnv: process.env.APP_ENV ?? localVars.APP_ENV,
	transport: process.env.EMAIL_TRANSPORT ?? localVars.EMAIL_TRANSPORT,
	sender: process.env.EMAIL_FROM ?? localVars.EMAIL_FROM,
	sendEmailBinding: "present",
	resendApiKey: process.env.RESEND_API_KEY?.trim() ? "present" : "absent",
});
if (localEmail.delivery === "log_only") {
	ok("Local email is log-only: auth links print in the dev server output");
} else if (localEmail.delivery === "provider") {
	ok(`Local email sends through ${localEmail.transport}`);
} else {
	warn(`Local email cannot send: ${localEmail.reason}`);
}
const productionVars = deploymentCloudflare.vars;
const productionEmail = describeEmailDelivery({
	appEnv: productionVars.APP_ENV,
	transport: productionVars.EMAIL_TRANSPORT,
	sender: productionVars.EMAIL_FROM,
	sendEmailBinding: "present",
	resendApiKey: "present",
});
if (productionEmail.delivery === "unavailable") {
	warn(
		[
			`Production email is not configured: ${productionEmail.reason}`,
			`     Disabled until it is: ${EMAIL_DEPENDENT_FEATURES.join(", ")}.`,
			"     Bootstrap the first admin with `pnpm admin:bootstrap`, then add",
			"     people from /app/ts_admin/users with Create user. See docs/email.md.",
		].join("\n")
	);
} else if (productionEmail.delivery === "provider") {
	ok(
		`Production email: ${productionEmail.transport} from ${productionVars.EMAIL_FROM} (confirm the domain with \`pnpm exec void email status --platform cloudflare\`)`
	);
}

// Flags are optional: without the FLAGS binding every flag serves its
// registry default, which is safe but means nothing can be turned on.
const declaredFlags = Object.keys(featureFlags).length;
if (localCloudflare.flagship.some((entry) => entry.binding === "FLAGS")) {
	ok(
		`Local flags: FLAGS reads the local flag store (${declaredFlags} declared; \`pnpm flags\` lists them)`
	);
} else {
	warn("Local flags: no FLAGS binding, so every flag serves its default");
}
if (deploymentCloudflare.flagship.some((entry) => entry.binding === "FLAGS")) {
	const appId = recordedFlagshipAppId();
	ok(
		appId === undefined
			? `Production flags: \`pnpm run deploy\` creates or reuses the Flagship app "${deploymentCloudflare.name}"`
			: `Production flags: Flagship app ${appId} (void.lock.json)`
	);
} else {
	warn(
		"Production flags: no FLAGS binding, so every flag serves its default"
	);
}
for (const { key, problem } of flagRegistryProblems(featureFlags, {
	nowUnixMs: Date.now(),
})) {
	// The registry unit test fails verify; here it is a reminder.
	warn(`Feature flag ${key}: ${problem}`);
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

// The app ID deploy recorded, if it has run. Void owns this file's format.
/** @returns {string | undefined} */
function recordedFlagshipAppId() {
	const lockPath = path.resolve(cwd, "void.lock.json");
	if (!fs.existsSync(lockPath)) return undefined;
	/** @type {unknown} */
	const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
	if (typeof lock !== "object" || lock === null || !("resolved" in lock))
		return undefined;
	const { resolved } = lock;
	if (typeof resolved !== "object" || resolved === null) return undefined;
	if (!("flagship" in resolved) || !Array.isArray(resolved.flagship))
		return undefined;
	for (const entry of resolved.flagship)
		if (entry?.binding === "FLAGS" && typeof entry.app_id === "string")
			return entry.app_id;
	return undefined;
}
