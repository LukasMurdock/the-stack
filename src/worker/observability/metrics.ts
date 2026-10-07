import type { RouteLabel } from "./route-label";

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

// v1 positions are persisted data: never reorder these fields or reuse a slot.
export const OPERATION_METRIC_VERSION = "v1";
const blobFields = [
	"schemaVersion",
	"environment",
	"version",
	"surface",
	"method",
	"route",
	"category",
	"colo",
] as const;
const doubleFields = [
	"durationMs",
	"status",
	"serverError",
	"slowRequest",
	"count",
] as const;

export function operationBlobColumn(
	field: (typeof blobFields)[number]
): string {
	return `blob${blobFields.indexOf(field) + 1}`;
}
export function operationDoubleColumn(
	field: (typeof doubleFields)[number]
): string {
	return `double${doubleFields.indexOf(field) + 1}`;
}

// Versioned, fixed-position operational schema. Never include session/user IDs,
// raw URLs, query strings, SQL, headers, or exception messages in this dataset.
export function recordOperation(args: {
	env: OperationEnvironment;
	requestId: string;
	surface: "api" | "page";
	method: string;
	route: RouteLabel;
	category: string;
	colo?: string | null;
	status: number;
	durationMs: number;
}): void {
	try {
		const binding = args.env.TURRET_METRICS;
		if (!binding) return;
		const environment = args.env.APP_ENV ?? "unknown";
		const blobs = {
			schemaVersion: OPERATION_METRIC_VERSION,
			environment,
			version: args.env.CF_VERSION_METADATA?.id ?? "unknown",
			surface: args.surface,
			method: args.method,
			route: args.route.slice(0, 256),
			category: args.category,
			colo: args.colo ?? "unknown",
		} satisfies Record<(typeof blobFields)[number], string>;
		const doubles = {
			durationMs: args.durationMs,
			status: args.status,
			serverError: args.status >= 500 ? 1 : 0,
			slowRequest: args.durationMs > 1000 ? 1 : 0,
			count: 1,
		} satisfies Record<(typeof doubleFields)[number], number>;
		binding.writeDataPoint({
			indexes: [environment],
			blobs: blobFields.map((field) => blobs[field]),
			doubles: doubleFields.map((field) => doubles[field]),
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
