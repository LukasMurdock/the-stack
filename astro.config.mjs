import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	integrations: [react()],
	adapter: cloudflare(),
	// Marketing pages are prerendered by default.
	// Pages or islands can opt into SSR with `export const prerender = false`.
	output: "static",
	vite: {
		optimizeDeps: {
			exclude: ["astro:middleware"],
		},
		resolve: {
			dedupe: ["react", "react-dom"],
		},
		plugins: [
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
