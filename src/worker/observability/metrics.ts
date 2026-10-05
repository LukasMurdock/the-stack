export type MetricsBinding = {
	writeDataPoint(point: {
		indexes: string[];
		blobs: string[];
		doubles: number[];
	}): void;
};

export type OperationEnvironment = {
	APP_ENV?: string;
	CF_VERSION_METADATA?: { id: string };
	TURRET_METRICS?: MetricsBinding;
};

export function requestCategory(path: string): string {
	if (path.startsWith("/api/internal/")) return "admin";
	if (path === "/api/health") return "health";
	if (path.startsWith("/api/auth/")) return "auth";
	if (path.startsWith("/api/turret/")) return "ingest";
	return "application";
}

// Versioned, fixed-position operational schema. Never include session/user IDs,
// raw URLs, query strings, SQL, headers, or exception messages in this dataset.
export function recordOperation(args: {
	env: OperationEnvironment;
	requestId: string;
	surface: "api" | "page";
	method: string;
	route: string;
	category: string;
	colo?: string | null;
	status: number;
	durationMs: number;
}): void {
	try {
		const environment = args.env.APP_ENV ?? "unknown";
		args.env.TURRET_METRICS?.writeDataPoint({
			indexes: [environment],
			blobs: [
				"v1",
				environment,
				args.env.CF_VERSION_METADATA?.id ?? "unknown",
				args.surface,
				args.method,
				args.route.slice(0, 256),
				args.category,
				args.colo ?? "unknown",
			],
			doubles: [
				args.durationMs,
				args.status,
				args.status >= 500 ? 1 : 0,
				args.durationMs > 1000 ? 1 : 0,
				1,
			],
		});
	} catch (error) {
		// A telemetry failure must never change the application response.
		console.error(
			{
				action: "observability.metrics_failed",
				requestId: args.requestId,
			},
			error
		);
	}
}
