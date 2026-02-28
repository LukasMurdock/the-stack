import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

const cwd = process.cwd();
const devVarsPath = path.resolve(cwd, ".dev.vars");
if (fs.existsSync(devVarsPath)) {
	dotenv.config({ path: devVarsPath, quiet: true });
}

function line(label, value) {
	process.stdout.write(`${label.padEnd(18)} ${value}\n`);
}

const appUrlRaw = process.env.APP_URL || "http://localhost:4321";
let appOrigin = appUrlRaw.replace(/\/+$/, "");
try {
	appOrigin = new URL(appUrlRaw).origin;
} catch {
	// keep normalized fallback
}
const configuredTurretMode = (process.env.TURRET_MODE || "full")
	.trim()
	.toLowerCase();
const hasSigningKey =
	Boolean(process.env.TURRET_SIGNING_KEY) &&
	process.env.TURRET_SIGNING_KEY !== "replace-me";

let effectiveTurretMode = configuredTurretMode;
if (configuredTurretMode === "full" && !hasSigningKey) {
	effectiveTurretMode = "basic (degraded: missing TURRET_SIGNING_KEY)";
}

process.stdout.write("Local dev status\n\n");
line("APP_URL", appOrigin);
line("ADMIN_EMAIL", process.env.ADMIN_EMAIL || "(not set)");
line("Turret mode", `${configuredTurretMode} -> ${effectiveTurretMode}`);
process.stdout.write("\n");

line("Marketing", `${appOrigin}/`);
line("App", `${appOrigin}/app`);
line("Docs", `${appOrigin}/docs`);
line("API health", `${appOrigin}/api/health`);
line("API docs", `${appOrigin}/api/scalar`);

const adminPasswordPath = path.resolve(cwd, ".wrangler/.admin-password");
if (fs.existsSync(adminPasswordPath)) {
	line("Admin password", ".wrangler/.admin-password");
} else {
	line("Admin password", "not created yet");
}
