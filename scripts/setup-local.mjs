import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

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

const cwd = process.cwd();
const devVarsPath = path.resolve(cwd, ".dev.vars");
const devVarsExamplePath = path.resolve(cwd, ".dev.vars.example");

if (!fs.existsSync(devVarsPath)) {
	if (!fs.existsSync(devVarsExamplePath)) {
		throw new Error(
			"Missing .dev.vars.example. Cannot bootstrap local env."
		);
	}
	fs.copyFileSync(devVarsExamplePath, devVarsPath);
	log("Created .dev.vars from .dev.vars.example");
}

const parsed = dotenv.config({ path: devVarsPath, quiet: true });
if (parsed.error) {
	throw parsed.error;
}

const requiredKeys = ["BETTER_AUTH_SECRET", "APP_URL", "ADMIN_EMAIL"];
const missing = requiredKeys.filter((key) => {
	const value = process.env[key];
	if (!value) return true;
	if (value === "replace-me") return true;
	return false;
});

if (missing.length > 0) {
	log("Please update .dev.vars before continuing.");
	log(`Missing required values: ${missing.join(", ")}`);
	process.exit(1);
}

runNodeScript("scripts/dev-doctor.mjs");

runCommand("npx", ["wrangler", "d1", "migrations", "apply", "CORE_DB", "--local"]);
runCommand("npx", ["wrangler", "d1", "migrations", "apply", "TURRET_DB", "--local"]);
runNodeScript("scripts/create-admin-local.mjs");

log("\nLocal setup complete.");
log("Next: just dev");
runNodeScript("scripts/dev-status.mjs");
