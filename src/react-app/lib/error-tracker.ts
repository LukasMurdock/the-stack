import { getTurretContext } from "./turretContext";
import { turretReportSessionError } from "./turretIngestApi";

type ErrorReportSource = "react-query" | "router" | "window";

type ReportErrorOptions = {
	source: ErrorReportSource;
	tags?: Record<string, string>;
	extra?: Record<string, unknown>;
};

function normalizeError(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack,
		};
	}
	return { message: typeof error === "string" ? error : "Unknown error" };
}

function reportError(error: unknown, options: ReportErrorOptions): void {
	const turret = getTurretContext();
	if (!turret) return;

	const { message, stack } = normalizeError(error);
	const ts = turret.lastRrwebTsMs ?? Date.now();

	void turretReportSessionError({
		sessionId: turret.sessionId,
		uploadToken: turret.uploadToken,
		payload: {
			ts,
			source: options.source,
			message,
			stack,
			extra: {
				...options.extra,
				...options.tags,
			},
		},
	}).catch((err) => {
		if (import.meta.env.DEV) {
			console.warn("Turret error report failed", err);
		}
	});
}

function initErrorTracking(): void {
	window.addEventListener("error", (ev) => {
		reportError(ev.error ?? ev.message, {
			source: "window",
			extra: { kind: "error", filename: ev.filename, lineno: ev.lineno, colno: ev.colno },
		});
	});

	window.addEventListener("unhandledrejection", (ev) => {
		reportError(ev.reason, {
			source: "window",
			extra: { kind: "unhandledrejection" },
		});
	});
}

export { initErrorTracking, reportError };
export type { ErrorReportSource, ReportErrorOptions };
