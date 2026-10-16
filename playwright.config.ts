import { defineConfig, devices } from "@playwright/test";
import { isAlive } from "./scripts/lib/local-server.mjs";
import { claimE2EPort, releaseE2EPort } from "./scripts/testing/e2e.mjs";

// The runner claims STACK_E2E_PORT, or the first free port from 4322, and fails
// fast when an explicit port is taken. Workers and the web server inherit it.
const owner = Number(process.env.STACK_E2E_OWNER);
if (owner !== process.pid && !(owner && isAlive(owner))) {
	const claimed = await claimE2EPort(process.env.STACK_E2E_PORT);
	process.env.STACK_E2E_PORT = String(claimed);
	process.env.STACK_E2E_OWNER = String(process.pid);
	process.once("exit", () => releaseE2EPort(claimed));
}
const port = Number(process.env.STACK_E2E_PORT);

export default defineConfig({
	testDir: "./tests/e2e",
	// Playwright empties this at startup; one per port keeps runs apart.
	outputDir: `test-results/${port}`,
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// prepare-e2e reuses this port's build when its inputs are unchanged.
		command: `node scripts/testing/prepare-e2e.mjs && STACK_E2E=1 node scripts/preview.mjs --port ${port} --host 127.0.0.1 --ignore-lock`,
		url: `http://localhost:${port}/api/readiness`,
		reuseExistingServer: false,
		// Port conflicts fail before this starts; the budget covers a cold
		// build on a loaded machine.
		timeout: 300_000,
	},
});
