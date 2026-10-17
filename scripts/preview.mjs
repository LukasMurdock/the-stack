import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { waitForHealth } from "./lib/local-server.ts";
import { e2ePaths, e2ePortFromEnv, withCheckoutLock } from "./testing/e2e.ts";

const VOID_POINTER = ".void/preview-deploy-config.json";

// Astro reads .wrangler/deploy/config.json before creating Vite's preview
// server. Void stashes it in VOID_POINTER after a build to prevent implicit
// Wrangler publication, and copies VOID_POINTER back when `astro preview`
// loads its config. Install the chosen pointer in both files, so a browser
// run serves its own build and not whichever build ran last in the checkout.
/** @param {string} pointer */
function start(pointer) {
	const text = readFileSync(pointer, "utf8");
	mkdirSync(".wrangler/deploy", { recursive: true });
	mkdirSync(".void", { recursive: true });
	writeFileSync(".wrangler/deploy/config.json", text);
	writeFileSync(VOID_POINTER, text);
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
	start(VOID_POINTER);
}
