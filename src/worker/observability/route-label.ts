import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

declare const routeLabel: unique symbol;
export type RouteLabel = string & { readonly [routeLabel]: true };

// Only registered route patterns and fixed boundary labels can become metric dimensions.
function label(path: string): RouteLabel {
	// SAFETY: this constructor is private; callers supply declared routes or fixed labels, never request URLs.
	return path as RouteLabel;
}

export const PAGE_ROUTE_LABEL = label("/astro/*");

export function apiRouteLabel(context: Context): RouteLabel {
	let path = "/api/*";
	for (const route of matchedRoutes(context))
		if (route.method !== "ALL") path = route.path;
	return label(path);
}
