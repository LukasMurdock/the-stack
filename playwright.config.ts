import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.STACK_E2E_PORT ?? 4322);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
	throw new Error("STACK_E2E_PORT must be an integer between 1024 and 65535");

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: `node scripts/testing/prepare-e2e.mjs && STACK_E2E=1 pnpm exec astro build && STACK_E2E=1 node scripts/preview.mjs --port ${port} --host 127.0.0.1 --ignore-lock`,
		url: `http://localhost:${port}/api/readiness`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
