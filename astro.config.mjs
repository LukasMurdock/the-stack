import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

import { voidPlugin } from "void";
import { writeLocalCloudflareConfig } from "./scripts/local-cloudflare.mjs";
import { buildCommit } from "./scripts/lib/build-commit.mjs";
import { defaultE2EPort, e2ePaths } from "./scripts/testing/e2e.mjs";

const e2e =
	process.env.STACK_E2E === "1"
		? e2ePaths(process.env.STACK_E2E_PORT ?? defaultE2EPort)
		: undefined;

export default defineConfig({
	// Preserve spacing between inline elements when upgrading from Astro 6.
	compressHTML: true,
	integrations: [react()],
	// Better Auth owns sessions; avoid an extra unprovisioned SESSION namespace.
	session: false,
	// Builds and local development must not open remote binding sessions.
	// Analytics SQL is available only in the deployed production Worker.
	adapter: cloudflare({
		remoteBindings: false,
		...(e2e
			? { configPath: e2e.config, persistState: { path: e2e.state } }
			: {
					configPath:
						process.env.STACK_BUILD === "deploy"
							? ".void-wrangler.jsonc"
							: writeLocalCloudflareConfig(),
					persistState: { path: ".wrangler/state" },
				}),
	}),
	// Marketing pages are prerendered by default.
	// Pages or islands can opt into SSR with `export const prerender = false`.
	output: "static",
	// Browser runs build per port so parallel runs cannot replace each other.
	...(e2e && { outDir: e2e.outDir }),
	vite: {
		// Reported by /api/health so `pnpm ship` can confirm what is live.
		define: { __STACK_COMMIT__: JSON.stringify(buildCommit()) },
		optimizeDeps: {
			exclude: ["astro:middleware", "rrweb"],
		},
		resolve: {
			dedupe: ["react", "react-dom"],
		},
		plugins: [
			...voidPlugin(),
			// Ensure TanStack Router runs before React plugin
			tanstackRouter({
				target: "react",
				autoCodeSplitting: true,
				routesDirectory: "./src/react-app/routes",
				generatedRouteTree: "./src/react-app/routeTree.gen.ts",
				quoteStyle: "double",
			}),
			tailwindcss(),
		],
	},
});
