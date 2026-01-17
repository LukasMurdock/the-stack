import { defineMiddleware } from "astro:middleware";

// Fetch Better Auth session for SSR-aware header rendering.
// This runs for all requests that reach Astro (non-/api/*).
export const onRequest = defineMiddleware(async (context, next) => {
	// Middleware runs at build-time for prerendered routes; request headers are not available.
	if (context.isPrerendered) {
		context.locals.session = null;
		return next();
	}

	const cookie = context.request.headers.get("cookie") ?? "";
	if (!cookie) {
		context.locals.session = null;
		return next();
	}

	try {
		const url = new URL("/api/auth/get-session", context.url.origin);
		const res = await fetch(url, {
			headers: {
				cookie,
			},
		});

		context.locals.session = res.ok ? await res.json() : null;
	} catch {
		context.locals.session = null;
	}

	return next();
});
