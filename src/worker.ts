import handler from "@astrojs/cloudflare/entrypoints/server";

import apiWorker from "./worker/index";

export default {
	async fetch(request: any, env: any, ctx: any) {
		const url = new URL(request.url);
		const p = url.pathname;

		// Route all API traffic through the existing Hono worker.
		if (p === "/api" || p.startsWith("/api/")) {
			return apiWorker.fetch(request, env as any, ctx);
		}

		return handler.fetch(request, env, ctx);
	},

	async scheduled(controller: any, env: any, ctx: any) {
		// Keep the existing cleanup job exactly as-is.
		if (apiWorker.scheduled) {
			return apiWorker.scheduled(controller, env as any, ctx);
		}
	},
};
