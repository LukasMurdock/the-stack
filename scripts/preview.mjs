import { copyFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { waitForHealth } from "./lib/local-server.ts";
import { e2ePaths, e2ePortFromEnv, withCheckoutLock } from "./testing/e2e.ts";

// Astro reads this pointer before creating Vite's preview server. Void stashes
// it after a build to prevent implicit Wrangler publication; restore it here
// before Astro starts, since Void's Vite hook runs too late for Astro 7.
/** @param {string} pointer */
function start(pointer) {
	mkdirSync(".wrangler/deploy", { recursive: true });
	copyFileSync(pointer, ".wrangler/deploy/config.json");
	const astro = spawn(
		"pnpm",
		["exec", "astro", "preview", ...process.argv.slice(2)],
		{ stdio: "inherit" }
	);
	astro.on("exit", (code, signal) =>
		process.exit(code ?? (signal ? 128 : 1))
	);
	return astro;
}

if (process.env.STACK_E2E === "1") {
	// Hold the checkout lock until this preview has read its own pointer, so
	// a parallel browser run cannot swap the pointer underneath it.
	const port = e2ePortFromEnv(process.env);
	await withCheckoutLock(process.cwd(), async () => {
		const astro = start(e2ePaths(port).deployConfig);
		const health = await waitForHealth(
			`http://127.0.0.1:${port}/api/readiness`,
			{ exited: () => astro.exitCode !== null }
		);
		// Playwright keeps waiting on its own deadline; say why the lock is
		// released before the preview answered.
		if (!health.ok)
			process.stderr.write(
				`Preview on port ${port} was not ready (${health.error}); releasing the checkout lock.\n`
			);
	});
} else {
	start(".void/preview-deploy-config.json");
}
