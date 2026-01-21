import handler from "@astrojs/cloudflare/entrypoints/server";

import apiWorker from "./worker/index";

export default {
	async fetch(request: any, env: any, ctx: any) {
		const url = new URL(request.url);
		const p = url.pathname;

		if (p === "/uptime" || p === "/uptime/" || p === "/uptime.json") {
			if (!env.UPTIME) return new Response("Uptime service unavailable", { status: 503 });
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response("Method Not Allowed", { status: 405 });
			}

			const cache = (caches as any).default as Cache;
			const cacheKey = new Request(url.origin + url.pathname + url.search, {
				method: "GET",
			});
			const cached = await cache.match(cacheKey);
			if (cached) return cached;

			const upstreamReq = new Request(request.url, {
				method: request.method,
				headers: {
					Accept: request.headers.get("Accept") ?? "*/*",
				},
			});
			const res = await env.UPTIME.fetch(upstreamReq);
			const ttl = 60;
			const out = new Response(res.body, res);
			out.headers.set("Cache-Control", `public, max-age=${ttl}`);
			out.headers.set("Vary", "Accept");
			ctx.waitUntil(cache.put(cacheKey, out.clone()));
			return out;
		}

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
