import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

import { voidPlugin } from "void";
import { writeLocalCloudflareConfig } from "./scripts/local-cloudflare.mjs";

const isE2E = process.env.STACK_E2E === "1";

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
		...(isE2E
			? {
					configPath: ".wrangler/e2e/wrangler.json",
					persistState: { path: ".wrangler/e2e/state" },
				}
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
	vite: {
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
