import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: "list",
	use: { baseURL: "http://localhost:4322", trace: "retain-on-failure" },
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command:
			"node scripts/testing/prepare-e2e.mjs && STACK_E2E=1 pnpm exec astro build && STACK_E2E=1 pnpm exec astro preview --port 4322 --host 127.0.0.1 --ignore-lock",
		url: "http://localhost:4322/api/readiness",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
