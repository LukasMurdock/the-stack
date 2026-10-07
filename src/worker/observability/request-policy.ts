// Each endpoint family declares its observability behavior together. Operational
// metrics cover all requests; replay breadcrumbs and errors have narrower coverage.
export function requestObservability(path: string) {
	const defaults = {
		category: "application",
		spanName: "api.request",
		captureBreadcrumbs: true,
		captureErrors: true,
	};
	if (!path.startsWith("/api/"))
		return { ...defaults, captureBreadcrumbs: false, captureErrors: false };
	if (path.startsWith("/api/auth/"))
		return {
			...defaults,
			category: "auth",
			spanName: "auth.request",
			captureBreadcrumbs: false,
		};
	if (path.startsWith("/api/turret/")) {
		// Upload failures must not feed back into the replay error store. Other
		// ingestion failures remain observable, but no ingest request gets breadcrumbs.
		const upload =
			path.startsWith("/api/turret/session/") ||
			path.startsWith("/api/turret/replay-session/");
		return {
			...defaults,
			category: "ingest",
			spanName: "turret.ingest",
			captureBreadcrumbs: false,
			captureErrors: !upload,
		};
	}
	if (path.startsWith("/api/internal/")) {
		const admin = { ...defaults, category: "admin" };
		if (path.startsWith("/api/internal/turret/"))
			return {
				...admin,
				spanName: "turret.admin",
				captureBreadcrumbs: false,
				captureErrors: false,
			};
		return admin;
	}
	if (path === "/api/health")
		return { ...defaults, category: "health", captureBreadcrumbs: false };
	if (["/api/doc", "/api/scalar", "/api/throw", "/api/fail"].includes(path))
		return { ...defaults, captureBreadcrumbs: false };
	return defaults;
}
