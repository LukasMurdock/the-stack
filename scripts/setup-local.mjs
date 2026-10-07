import { execFileSync } from "node:child_process";

import { loadLocalEnv } from "./local-env.mjs";

function log(message) {
	process.stdout.write(`${message}\n`);
}

function runCommand(command, args) {
	log(`\n> ${command} ${args.join(" ")}`);
	execFileSync(command, args, { stdio: "inherit" });
}

function runNodeScript(scriptPath) {
	log(`\n> node ${scriptPath}`);
	execFileSync("node", [scriptPath], { stdio: "inherit" });
}

runNodeScript("scripts/setup-local-env.mjs");

const parsed = loadLocalEnv();
if (parsed.error) {
	throw parsed.error;
}
// Local setup and the Worker must agree even if the shell exports another secret.
process.env.BETTER_AUTH_SECRET = parsed.parsed.BETTER_AUTH_SECRET;

const requiredKeys = ["BETTER_AUTH_SECRET", "APP_URL", "ADMIN_EMAIL"];
const missing = requiredKeys.filter((key) => {
	const value = process.env[key];
	if (!value) return true;
	if (value === "replace-me") return true;
	return false;
});

if (missing.length > 0) {
	log("Please update .dev.vars before continuing.");
	log("Required values: BETTER_AUTH_SECRET, APP_URL, ADMIN_EMAIL");
	log(`Missing or placeholder values: ${missing.join(", ")}`);
	process.exit(1);
}

runNodeScript("scripts/dev-doctor.mjs");

runCommand("pnpm", [
	"exec",
	"wrangler",
	"d1",
	"migrations",
	"apply",
	"CORE_DB",
	"--local",
]);
runCommand("pnpm", [
	"exec",
	"wrangler",
	"d1",
	"migrations",
	"apply",
	"TURRET_DB",
	"--local",
]);
runNodeScript("scripts/create-admin-local.mjs");

log("\nLocal setup complete.");
log("Next: pnpm dev");
runNodeScript("scripts/dev-status.mjs");
log("\nSign in with the email and password in .wrangler/.admin-password.");
log(
	"Create an organization, open it, then select Projects to create your first record."
);
log("Follow the First feature URL above to extend the example.");
