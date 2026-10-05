declare module "hono" {
	interface ContextVariableMap {
		requestId: string;
	}
}

import { recordOperation, requestCategory } from "./metrics";
import { createMiddleware } from "hono/factory";
import type { Bindings } from "../index";
import { wrapD1Database, type D1Span } from "./d1Proxy";
import { createApiRequestLogger } from "./evlog";
import { traceOperation } from "./tracing";
import { normalizeApiPath } from "../turret/fingerprinting";
import {
	recordWorkerError,
	recordBreadcrumb,
	shouldSkipTurretBreadcrumbCapture,
	shouldSkipTurretErrorCapture,
} from "./turret";

const MAX_REPLAY_D1_SPANS = 100;

export function resolveRequestId(input: string | null): string {
	return input && /^[A-Za-z0-9._:-]{1,128}$/.test(input)
		? input
		: crypto.randomUUID();
}

function requestSpanName(path: string): string {
	if (path.startsWith("/api/auth/")) return "auth.request";
	if (path.startsWith("/api/turret/")) return "turret.ingest";
	if (path.startsWith("/api/internal/turret/")) return "turret.admin";
	return "api.request";
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

		const sessionId = request.headers.get("x-turret-session-id");
		const replayTsRaw = request.headers.get("x-turret-replay-ts");
		const replayTs = replayTsRaw ? Number(replayTsRaw) : NaN;
		const ts = Number.isFinite(replayTs) ? replayTs : Date.now();
		const rayId = request.headers.get("cf-ray") ?? null;
		const colo =
			(request as Request & { cf?: { colo?: string } }).cf?.colo ?? null;

		const shouldCaptureBreadcrumb =
			!shouldSkipTurretBreadcrumbCapture(request);
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
				replayTs: Number.isFinite(replayTs) ? replayTs : null,
			},
			route: { pathTemplate },
		});
		const d1Spans: D1Span[] = [];
		const d1 = {
			captured: shouldCaptureBreadcrumb,
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
		if (shouldCaptureBreadcrumb) {
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
				requestSpanName(path),
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
					if (c.error) span?.recordException(c.error);
				}
			);
			if (c.error) {
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

			if (
				!shouldSkipTurretErrorCapture(request) &&
				(hasException || status >= 500)
			) {
				c.executionCtx.waitUntil(
					recordWorkerError({
						env: originalEnv,
						request,
						requestId,
						status,
						kind: hasException ? "exception" : "http_5xx",
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
				category: requestCategory(path),
				colo,
				status,
				durationMs,
			});

			if (shouldCaptureBreadcrumb) {
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
