import { copyFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { waitForHealth } from "./lib/local-server.mjs";
import { defaultE2EPort, e2ePaths, withCheckoutLock } from "./testing/e2e.mjs";

// Astro reads this pointer before creating Vite's preview server. Void stashes
// it after a build to prevent implicit Wrangler publication; restore it here
// before Astro starts, since Void's Vite hook runs too late for Astro 7.
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
	const port = process.env.STACK_E2E_PORT ?? defaultE2EPort;
	await withCheckoutLock(process.cwd(), async () => {
		const astro = start(e2ePaths(port).deployConfig);
		await waitForHealth(`http://127.0.0.1:${port}/api/readiness`, {
			exited: () => astro.exitCode !== null,
		});
	});
} else {
	start(".void/preview-deploy-config.json");
}
