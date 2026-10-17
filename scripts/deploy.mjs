import { spawnSync } from "node:child_process";
import { deploymentCloudflare } from "../config/cloudflare.mjs";
import { releaseSummary } from "./lib/release.ts";
import { normalizeVoidLock } from "./lib/void-lock.ts";
import { provisionResources } from "./provision-resources.mjs";

// A failed command; its own output already explains why.
class StepFailed extends Error {
	/** @param {number} exitCode */
	constructor(exitCode) {
		super(`exit ${exitCode}`);
		this.exitCode = exitCode;
	}
}

/** @param {string[]} args */
function run(args) {
	const result = spawnSync("pnpm", args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new StepFailed(result.status ?? 1);
}

// Void records the last build's output (main, assets) in void.lock.json, and
// the next build would read it back; restore the authored values before
// building and after Void publishes.
function normalizeLock() {
	const restored = normalizeVoidLock(process.cwd());
	if (restored.length > 0)
		process.stdout.write(
			`void.lock.json: restored the authored ${restored.join(", ")} (scripts/lib/void-lock.ts).\n`
		);
}

try {
	normalizeLock();
	// Select and pin the app's account before Void creates any resources.
	run(["exec", "void", "connect", "--platform", "cloudflare"]);
	const { configPath, config } = await provisionResources();
	run(["run", "check"]);
	for (const database of config.d1_databases ?? [])
		run([
			"exec",
			"wrangler",
			"d1",
			"migrations",
			"apply",
			database.binding,
			"--remote",
			"--config",
			configPath,
		]);
	try {
		run(["exec", "void", "deploy", "--platform", "cloudflare"]);
	} finally {
		normalizeLock();
	}
	const { APP_URL, ADMIN_EMAIL } = deploymentCloudflare.vars;
	// `pnpm ship` prints this once production serves the new commit.
	if (!process.env.STACK_SHIP)
		process.stdout.write(
			`\n${releaseSummary({ origin: new URL(APP_URL).origin, adminEmail: ADMIN_EMAIL })}\n`
		);
} catch (error) {
	if (error instanceof StepFailed) process.exitCode = error.exitCode;
	else {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	}
}
