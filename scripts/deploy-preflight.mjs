import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

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

const parsedConfig = ts.parseConfigFileTextToJson(wranglerPath, wranglerRaw);
if (parsedConfig.error) {
	fail("wrangler.json is not valid JSONC");
	failed = true;
} else {
	const production = parsedConfig.config?.env?.production;
	const transport = production?.vars?.EMAIL_TRANSPORT ?? "cloudflare";
	const sender = production?.vars?.EMAIL_FROM;
	if (
		!sender ||
		/your-app\.example|localhost|\[email protected\]/i.test(sender)
	) {
		fail(
			"Configure env.production.vars.EMAIL_FROM with an onboarded sender mailbox"
		);
		failed = true;
	}
	if (!["cloudflare", "resend"].includes(transport)) {
		fail("Production EMAIL_TRANSPORT must be cloudflare or resend");
		failed = true;
	} else if (
		transport === "cloudflare" &&
		!production?.send_email?.some((binding) => binding.name === "EMAIL")
	) {
		fail("Cloudflare email requires send_email EMAIL in env.production");
		failed = true;
	} else {
		ok(
			`Production email transport: ${transport} (verify domain/secrets with a live acceptance test)`
		);
	}
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
	run("pnpm", ["run", "test"]);
	ok("Fast checks passed");
} catch (error) {
	fail("Fast checks failed (pnpm run test)");
	failed = true;
}

if (!skipBuild) {
	try {
		run("pnpm", ["run", "build"], {
			env: { ...process.env, CLOUDFLARE_ENV: "production" },
		});
		ok("Build passed");
	} catch {
		fail("Build failed (pnpm run build)");
		failed = true;
	}
} else {
	warn("Skipped build check (--skip-build)");
}

if (!skipDryRun) {
	let canUseWrangler = true;
	try {
		run("pnpm", ["exec", "wrangler", "--version"]);
	} catch {
		canUseWrangler = false;
		warn("Wrangler unavailable; skipping dry-run");
	}

	if (canUseWrangler) {
		try {
			run("pnpm", ["exec", "wrangler", "whoami"]);
		} catch {
			warn(
				"Wrangler auth unavailable (pnpm exec wrangler whoami failed); skipping dry-run"
			);
			canUseWrangler = false;
		}
	}

	if (canUseWrangler) {
		try {
			run("pnpm", [
				"exec",
				"wrangler",
				"deploy",
				"--config",
				"dist/server/wrangler.json",
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
