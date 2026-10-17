import handler from "@astrojs/cloudflare/entrypoints/server";

import apiWorker, { type Bindings } from "./worker/index";
import { observePageRequest } from "./worker/observability/page";
import { discardUnreadBody } from "./worker/http/unread-body";
import {
	isHashedAssetPath,
	serveHashedAsset,
} from "./worker/http/hashed-assets";

type WorkerBindings = Bindings & { ASSETS: Fetcher };

export default {
	async fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext) {
		const response = await route(request, env, ctx);
		ctx.waitUntil(discardUnreadBody(request));
		return response;
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

function route(
	request: Request,
	env: WorkerBindings,
	ctx: ExecutionContext
): Promise<Response> {
	const url = new URL(request.url);
	const p = url.pathname;

	// Fingerprinted build output: straight from ASSETS, cacheable for a year.
	if (isHashedAssetPath(p)) {
		return serveHashedAsset(request, env.ASSETS);
	}

	// Route all API traffic through the existing Hono worker.
	if (p === "/api" || p.startsWith("/api/")) {
		return Promise.resolve(apiWorker.fetch(request, env, ctx));
	}

	return observePageRequest(request, env, ctx, () =>
		handler.fetch(request, env, ctx)
	);
}
