import { spawnSync } from "node:child_process";
import { deploymentCloudflare } from "../config/cloudflare.mjs";
import { releaseSummary } from "./lib/release.mjs";
import { provisionResources } from "./provision-resources.mjs";

function run(args) {
	const result = spawnSync("pnpm", args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
	// Select and pin the app's account before Void creates any resources.
	run(["exec", "void", "connect", "--platform", "cloudflare"]);
	const { configPath, config } = await provisionResources();
	run(["run", "check"]);
	for (const database of config.d1_databases)
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
	run(["exec", "void", "deploy", "--platform", "cloudflare"]);
	const { APP_URL, ADMIN_EMAIL } = deploymentCloudflare.vars;
	// `pnpm ship` prints this once production serves the new commit.
	if (!process.env.STACK_SHIP)
		process.stdout.write(
			`\n${releaseSummary({ origin: new URL(APP_URL).origin, adminEmail: ADMIN_EMAIL })}\n`
		);
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exitCode = 1;
}
