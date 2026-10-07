export const CLOUDFLARE_TRACES_URL =
	"https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/traces";

// The dashboard link can't be pre-filtered, and traces are head-sampled.
export const TRACE_LINK_HINT =
	"Opens Cloudflare Workers traces in a new tab. Search there for the Ray ID or request ID. Traces are sampled, so this request may not have one.";
