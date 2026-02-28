import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
}

function ok(message) {
	process.stdout.write(`OK   ${message}\n`);
}

function warn(message) {
	process.stdout.write(`WARN ${message}\n`);
}

function fail(message) {
	process.stdout.write(`FAIL ${message}\n`);
}

const args = new Set(process.argv.slice(2));
const skipDryRun = args.has("--skip-dry-run");
const skipBuild = args.has("--skip-build");

const wranglerPath = path.resolve(process.cwd(), "wrangler.json");
const wranglerRaw = fs.readFileSync(wranglerPath, "utf8");

let failed = false;

if (wranglerRaw.includes("https://your-app.example")) {
	fail(
		"wrangler.json still has placeholder APP_URL in env.production.vars.APP_URL"
	);
	failed = true;
} else {
	ok("Production APP_URL placeholder replaced");
}

if (wranglerRaw.includes("admin@your-app.example")) {
	fail(
		"wrangler.json still has placeholder ADMIN_EMAIL in env.production.vars.ADMIN_EMAIL"
	);
	failed = true;
} else {
	ok("Production ADMIN_EMAIL placeholder replaced");
}

const placeholderDbIdMatches =
	wranglerRaw.match(
		/"database_id"\s*:\s*"00000000-0000-0000-0000-000000000000"/g
	) ?? [];
if (placeholderDbIdMatches.length > 0) {
	fail(
		"wrangler.json still has placeholder production D1 database_id values"
	);
	failed = true;
} else {
	ok("Production D1 database IDs look configured");
}

try {
	run("npm", ["run", "test"]);
	ok("Fast checks passed");
} catch (error) {
	fail("Fast checks failed (npm run test)");
	failed = true;
}

if (!skipBuild) {
	try {
		run("npm", ["run", "build"]);
		ok("Build passed");
	} catch {
		fail("Build failed (npm run build)");
		failed = true;
	}
} else {
	warn("Skipped build check (--skip-build)");
}

if (!skipDryRun) {
	let canUseWrangler = true;
	try {
		run("npx", ["wrangler", "--version"]);
	} catch {
		canUseWrangler = false;
		warn("Wrangler unavailable; skipping dry-run");
	}

	if (canUseWrangler) {
		try {
			run("npx", ["wrangler", "whoami"]);
		} catch {
			warn(
				"Wrangler auth unavailable (npx wrangler whoami failed); skipping dry-run"
			);
			canUseWrangler = false;
		}
	}

	if (canUseWrangler) {
		try {
			run("npx", [
				"wrangler",
				"deploy",
				"--config",
				"wrangler.json",
				"--env",
				"production",
				"--dry-run",
			]);
			ok("Wrangler production dry-run passed");
		} catch {
			fail("Wrangler production dry-run failed");
			failed = true;
		}
	}
} else {
	warn("Skipped wrangler dry-run (--skip-dry-run)");
}

process.stdout.write("\n");
if (failed) {
	process.stdout.write("Result: NO-GO\n");
	process.exit(1);
}

process.stdout.write("Result: GO\n");
