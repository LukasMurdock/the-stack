import { requestObservability } from "./request-policy";
import { readTurretCorrelation } from "../../contracts/turret-correlation";
import { getRequestLocation } from "../../lib/cloudflareRequest";
declare module "hono" {
	interface ContextVariableMap {
		requestId: string;
	}
}

import { recordOperation } from "./metrics";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "../index";
import { wrapD1Database, type D1Span } from "./d1Proxy";
import { createApiRequestLogger } from "./evlog";
import { traceOperation } from "./tracing";
import { normalizeApiPath } from "../turret/fingerprinting";
import { recordWorkerError, recordBreadcrumb } from "./turret";

const MAX_REPLAY_D1_SPANS = 100;

export function resolveRequestId(input: string | null): string {
	return input && /^[A-Za-z0-9._:-]{1,128}$/.test(input)
		? input
		: crypto.randomUUID();
}

export const observeRequest = createMiddleware<{ Bindings: Bindings }>(
	async (c, next) => {
		const originalEnv = { ...c.env };
		const request = c.req.raw;
		const url = new URL(request.url);

		const requestId = resolveRequestId(request.headers.get("x-request-id"));
		c.set("requestId", requestId);
		const path = url.pathname;

		const pathTemplate = normalizeApiPath(path);

		const correlation = readTurretCorrelation(request.headers, Date.now());
		const { sessionId, replayTs, ts } = correlation;
		const rayId = request.headers.get("cf-ray") ?? null;
		const colo = getRequestLocation(request).colo ?? null;

		const { category, spanName, captureBreadcrumbs, captureErrors } =
			requestObservability(path);
		const requestLog = createApiRequestLogger({
			request,
			requestId,
			pathTemplate,
			executionCtx: c.executionCtx,
		});
		requestLog.set({
			action: "api.request",
			app: { env: c.env.APP_ENV, version: c.env.CF_VERSION_METADATA?.id },
			cloudflare: { rayId, colo },
			turret: {
				sessionId: sessionId ?? null,
				replayTs,
			},
			route: { pathTemplate },
		});
		const d1Spans: D1Span[] = [];
		const d1 = {
			captured: captureBreadcrumbs,
			queries: 0,
			timeMs: 0,
			rowsRead: 0,
			rowsWritten: 0,
			errors: 0,
			droppedSpans: 0,
		};
		const collector = {
			push(span: D1Span) {
				if (span.kind === "d1.query") {
					d1.queries++;
					d1.timeMs += span.durationMs;
					d1.rowsRead += span.rowsRead ?? 0;
					d1.rowsWritten += span.rowsWritten ?? 0;
				} else {
					d1.errors++;
				}
				if (d1Spans.length < MAX_REPLAY_D1_SPANS) d1Spans.push(span);
				else d1.droppedSpans++;
			},
		};

		// Wrap D1 bindings per request to capture query spans.
		if (captureBreadcrumbs) {
			const requestEnv = c.env;
			if (requestEnv.CORE_DB) {
				requestEnv.CORE_DB = wrapD1Database({
					db: requestEnv.CORE_DB,
					dbName: "CORE_DB",
					collector,
				});
			}
			if (requestEnv.TURRET_DB) {
				requestEnv.TURRET_DB = wrapD1Database({
					db: requestEnv.TURRET_DB,
					dbName: "TURRET_DB",
					collector,
				});
			}
		}

		const t0 = Date.now();
		let caughtError: unknown = null;

		let hasException = false;
		try {
			await traceOperation(
				c.executionCtx,
				spanName,
				{
					"request.id": requestId,
					"turret.session_id": sessionId ?? undefined,
					"app.env": c.env.APP_ENV,
					"app.version": c.env.CF_VERSION_METADATA?.id,
					"http.route": pathTemplate,
				},
				async (span) => {
					await next();
					span?.setAttributes({
						"http.response.status_code": c.res.status,
					});
					// Hono converts route exceptions into responses before next() returns.
					// An error mapped to an expected 4xx outcome is already handled.
					if (c.error && c.res.status >= 500)
						span?.recordException(c.error);
				}
			);
			if (c.error && c.res.status >= 500) {
				caughtError = c.error;
				hasException = true;
			}
		} catch (error) {
			caughtError = error;
			hasException = true;
			throw error;
		} finally {
			const durationMs = Math.max(0, Date.now() - t0);
			const status = hasException ? 500 : c.res.status;

			// Echo request ID to client for debugging.
			try {
				c.header("x-request-id", requestId);
			} catch {
				// ignore
			}

			if (captureErrors && (hasException || status >= 500)) {
				c.executionCtx.waitUntil(
					recordWorkerError({
						env: originalEnv,
						request,
						requestId,
						status,
						kind: hasException ? "exception" : "http_5xx",
						correlation,
						error: caughtError,
					})
				);
			}
			const {
				queries: d1QueriesCount,
				timeMs: d1QueriesTimeMs,
				rowsRead: d1RowsRead,
				rowsWritten: d1RowsWritten,
				errors: d1ErrorsCount,
			} = d1;

			const errorKind = hasException
				? "exception"
				: status >= 500
					? "http_5xx"
					: null;
			const errorMessage =
				caughtError instanceof Error
					? caughtError.message
					: typeof caughtError === "string"
						? caughtError
						: errorKind
							? `HTTP ${status}`
							: null;

			if (hasException)
				requestLog.error(
					caughtError instanceof Error
						? caughtError
						: String(caughtError)
				);
			if (errorKind)
				requestLog.set({
					error: { kind: errorKind, message: errorMessage },
				});
			requestLog.set({ durationMs, d1 });

			requestLog.emit({ status });
			recordOperation({
				env: originalEnv,
				requestId,
				surface: "api",
				method: request.method,
				route: pathTemplate,
				category,
				colo,
				status,
				durationMs,
			});

			if (captureBreadcrumbs) {
				c.executionCtx.waitUntil(
					recordBreadcrumb({
						env: originalEnv,
						request,
						requestId,
						sessionId,
						ts,
						pathTemplate,
						status,
						durationMs,
						rayId,
						colo,
						d1QueriesCount,
						d1QueriesTimeMs,
						d1RowsRead,
						d1RowsWritten,
						d1ErrorsCount,
						errorKind,
						errorMessage,
						d1Spans,
					})
				);
			}
		}
	}
);
