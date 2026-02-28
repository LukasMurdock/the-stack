import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function log(message) {
	process.stdout.write(`${message}\n`);
}

const cwd = process.cwd();
const d1StatePath = path.resolve(cwd, ".wrangler/state/v3/d1");
const adminPasswordPath = path.resolve(cwd, ".wrangler/.admin-password");

if (fs.existsSync(d1StatePath)) {
	fs.rmSync(d1StatePath, { recursive: true, force: true });
	log("Removed local D1 state (.wrangler/state/v3/d1)");
} else {
	log("Local D1 state not found; nothing to remove");
}

if (fs.existsSync(adminPasswordPath)) {
	fs.rmSync(adminPasswordPath, { force: true });
	log("Removed cached admin credential file (.wrangler/.admin-password)");
}

log("\nRebuilding local state...");
execFileSync("node", ["scripts/setup-local.mjs"], { stdio: "inherit" });

log("\nLocal reset complete.");
