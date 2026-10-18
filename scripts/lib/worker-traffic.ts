// How the production Worker is reached: `routes` (custom domains and zone
// routes), `workers_dev` (<name>.<subdomain>.workers.dev) and `preview_urls`
// (each version's own URL). When the config leaves one out, Void 1.1 keeps the
// live version's value from the metadata Void attached to it. A version Void
// did not upload (one published by `wrangler deploy`, the dashboard, or the
// switch to Secrets Store) has no such metadata, so `void deploy` stops with
// "dashboard-managed routes or visibility that Void cannot safely republish"
// unless all three are declared. Declaring them also makes every deploy state
// the Worker's traffic instead of inheriting whatever was set by hand.

import { z } from "zod";

export type TrafficSetting = "routes" | "workers_dev" | "preview_urls";

const trafficSchema = z.looseObject({
	routes: z.array(z.unknown()).optional(),
	// Wrangler's single-route form counts as declaring routes.
	route: z.unknown().optional(),
	workers_dev: z.boolean().optional(),
	preview_urls: z.boolean().optional(),
});

// The traffic settings a Cloudflare config leaves to Void's inheritance.
export function undeclaredTrafficSettings(
	config: unknown
): readonly TrafficSetting[] {
	const parsed = trafficSchema.parse(config);
	const missing: TrafficSetting[] = [];
	if (parsed.routes === undefined && parsed.route === undefined)
		missing.push("routes");
	if (parsed.workers_dev === undefined) missing.push("workers_dev");
	if (parsed.preview_urls === undefined) missing.push("preview_urls");
	return missing;
}

// One problem naming every undeclared setting, or none.
export function trafficConfigProblems(config: unknown): readonly string[] {
	const missing = undeclaredTrafficSettings(config);
	if (missing.length === 0) return [];
	return [
		`The production config does not declare ${missing.join(", ")}. void deploy refuses to republish a Worker it did not upload ("dashboard-managed routes or visibility") unless routes, workers_dev and preview_urls are all explicit. Declare them in deploymentCloudflare (config/cloudflare.mjs): routes: [] for none, workers_dev and preview_urls true or false.`,
	];
}
