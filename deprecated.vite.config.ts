import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	server: {
		cors: false,
	},
	build: {
		sourcemap: true,
	},
	plugins: [
		// Ensure TanStack Router runs before the React plugin
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			routesDirectory: "./src/react-app/routes",
			generatedRouteTree: "./src/react-app/routeTree.gen.ts",
			quoteStyle: "double",
		}),
		react(),
		tailwindcss(),
		cloudflare(),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
