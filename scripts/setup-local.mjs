import { execFileSync } from "node:child_process";

import { loadLocalEnv } from "./local-env.mjs";

/** @param {string} message */
function log(message) {
	process.stdout.write(`${message}\n`);
}

/**
 * @param {string} command
 * @param {string[]} args
 */
function runCommand(command, args) {
	log(`\n> ${command} ${args.join(" ")}`);
	execFileSync(command, args, { stdio: "inherit" });
}

/** @param {string} scriptPath */
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
const localSecret = parsed.parsed?.BETTER_AUTH_SECRET;
if (localSecret !== undefined) process.env.BETTER_AUTH_SECRET = localSecret;

const requiredKeys = ["BETTER_AUTH_SECRET", "APP_URL", "ADMIN_EMAIL"];
const missing = requiredKeys.filter((key) => {
	const value = process.env[key];
	if (!value) return true;
	if (value === "replace-me") return true;
	return false;
});

if (missing.length > 0) {
	log("Please update .env before continuing.");
	log("Required values: BETTER_AUTH_SECRET, APP_URL, ADMIN_EMAIL");
	log(`Missing or placeholder values: ${missing.join(", ")}`);
	process.exit(1);
}

runNodeScript("scripts/dev-doctor.mjs");

runCommand("pnpm", ["run", "db:local:migrate"]);
// Declared flags with their defaults, so local evaluation is deterministic.
runCommand("pnpm", ["run", "flags:local"]);
runNodeScript("scripts/create-admin-local.mjs");

log("\nLocal setup complete.");
log("Next: pnpm dev");
runNodeScript("scripts/dev-status.mjs");
log("\nSign in with the email and password in .wrangler/.admin-password.");
log("Create an organization to start.");
// example:start
log("Open it and select Projects to try the example; the First feature URL");
log("above extends it, and pnpm example:remove deletes it.");
// example:end
