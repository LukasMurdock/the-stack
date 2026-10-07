import handler from "@astrojs/cloudflare/entrypoints/server";

import apiWorker, { type Bindings } from "./worker/index";
import { observePageRequest } from "./worker/observability/page";

export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const p = url.pathname;

		// Route all API traffic through the existing Hono worker.
		if (p === "/api" || p.startsWith("/api/")) {
			return apiWorker.fetch(request, env, ctx);
		}

		return observePageRequest(request, env, ctx, () =>
			handler.fetch(request, env, ctx)
		);
	},

	async scheduled(
		controller: ScheduledController,
		env: Bindings,
		ctx: ExecutionContext
	) {
		if (apiWorker.scheduled) {
			return apiWorker.scheduled(controller, env, ctx);
		}
	},
};
