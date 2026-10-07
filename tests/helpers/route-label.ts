import type { RouteLabel } from "../../src/worker/observability/route-label";

export function testRouteLabel(path: string): RouteLabel {
	// SAFETY: test callers declare fixed endpoint patterns independently of request URLs.
	return path as RouteLabel;
}
