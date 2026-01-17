import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { eq, sql } from "drizzle-orm";
import { makeTurretDb } from "../bindings/d1/turret/db";
import * as turretSchema from "../bindings/d1/turret/schema";
import { wrapD1Database } from "./observability/d1Proxy";
import { api, apiRoutes } from "./api";
import { createAuth, type AuthEnv } from "./auth";

type Bindings = AuthEnv & {
	CF_VERSION_METADATA?: WorkerVersionMetadata;
};

const app = new Hono<{ Bindings: Bindings }>({
	strict: true,
});

function shouldSkipTurretErrorCapture(req: Request): boolean {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/")) return true;
	if (url.pathname.startsWith("/api/turret/session/")) return true;
	if (url.pathname.startsWith("/api/internal/turret/")) return true;
	return false;
}

function shouldSkipTurretBreadcrumbCapture(req: Request): boolean {
	const url = new URL(req.url);
	const p = url.pathname;
	if (!p.startsWith("/api/")) return true;
	if (p.startsWith("/api/turret/")) return true;
	if (p.startsWith("/api/internal/turret/")) return true;
	if (p.startsWith("/api/auth/")) return true;
	if (p === "/api/doc") return true;
	if (p === "/api/scalar") return true;
	if (p === "/api/health") return true;
	if (p === "/api/throw") return true;
	if (p === "/api/fail") return true;
	return false;
}

async function recordWorkerError(args: {
	env: Bindings & {
		TURRET_DB?: D1Database;
		TURRET_ANALYTICS?: {
			writeDataPoint(input: { blobs: string[]; doubles: number[] }): void;
		};
	};
	request: Request;
	kind: "exception" | "http_5xx";
	status?: number;
	error?: unknown;
}): Promise<void> {
	const dbBinding = args.env.TURRET_DB;
	if (!dbBinding) return;

	const sessionId = args.request.headers.get("x-turret-session-id");
	const replayTsRaw = args.request.headers.get("x-turret-replay-ts");
	const replayTs = replayTsRaw ? Number(replayTsRaw) : NaN;
	const ts = Number.isFinite(replayTs) ? replayTs : Date.now();
	const rayId = args.request.headers.get("cf-ray") ?? undefined;
	const colo = (args.request as Request & { cf?: { colo?: string } }).cf
		?.colo;

	let message: string | null = null;
	let stack: string | null = null;
	if (args.kind === "http_5xx") {
		message = `HTTP ${args.status ?? 500}`;
	} else if (args.error instanceof Error) {
		message = args.error.message;
		stack = args.error.stack ?? null;
	} else if (typeof args.error === "string") {
		message = args.error;
	}

	try {
		const turretDb = makeTurretDb(dbBinding);
		await turretDb.insert(turretSchema.turretSessionErrors).values({
			id: crypto.randomUUID(),
			sessionId: sessionId ?? null,
			ts: new Date(ts),
			source: "worker",
			message: message ? message.slice(0, 2000) : null,
			stack: stack ? stack.slice(0, 20000) : null,
			fingerprint: null,
			extraJson: JSON.stringify({
				kind: args.kind,
				status: args.status,
				url: args.request.url,
				method: args.request.method,
				ray_id: rayId,
				colo,
			}),
			createdAt: new Date(Date.now()),
		});

		if (sessionId) {
			await turretDb
				.update(turretSchema.turretSessions)
				.set({
					hasError: true,
					errorCount: sql`${turretSchema.turretSessions.errorCount} + 1`,
					updatedAt: new Date(Date.now()),
				})
				.where(eq(turretSchema.turretSessions.sessionId, sessionId));
		}

		args.env.TURRET_ANALYTICS?.writeDataPoint({
			blobs: ["worker_error", args.kind, String(args.status ?? "")],
			doubles: [1],
		});
	} catch (err) {
		console.error("Turret worker error capture failed", err);
	}
}

// CORS should be registered before routes.
app.use("/api/*", cors());

// Canonicalize `/api/*` to no trailing slash.
// This middleware only redirects for GET requests that result in a 404.
app.use("/api/*", trimTrailingSlash());

app.use("/api/*", async (c, next) => {
	const now = Date.now();
	const request = c.req.raw;
	const url = new URL(request.url);

	const requestId =
		request.headers.get("x-request-id") ?? crypto.randomUUID();
	const path = url.pathname;

	function normalizeApiPath(p: string): string {
		let out = p;
		out = out.replace(/\b\d+\b/g, ":id");
		out = out.replace(
			/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
			":id"
		);
		out = out.replace(/\b[0-9a-fA-F]{16,}\b/g, ":id");
		return out;
	}

	const pathTemplate = normalizeApiPath(path);

	const sessionId = request.headers.get("x-turret-session-id");
	const replayTsRaw = request.headers.get("x-turret-replay-ts");
	const replayTs = replayTsRaw ? Number(replayTsRaw) : NaN;
	const ts = Number.isFinite(replayTs) ? replayTs : Date.now();
	const rayId = request.headers.get("cf-ray") ?? null;
	const colo =
		(request as Request & { cf?: { colo?: string } }).cf?.colo ?? null;

	const shouldCaptureBreadcrumb = !shouldSkipTurretBreadcrumbCapture(request);
	const d1Spans: Array<{
		kind: "d1.query" | "d1.error";
		db: "CORE_DB" | "TURRET_DB";
		ts: number;
		durationMs: number;
		sqlShape: string;
		rowsRead?: number;
		rowsWritten?: number;
		errorMessage?: string;
	}> = [];

	// Wrap D1 bindings per request to capture query spans.
	if (shouldCaptureBreadcrumb) {
		const envAny = c.env as any;
		if (envAny.CORE_DB) {
			envAny.CORE_DB = wrapD1Database({
				db: envAny.CORE_DB,
				dbName: "CORE_DB",
				requestTs: ts,
				collector: { push: (s) => d1Spans.push(s as any) },
			});
		}
		if (envAny.TURRET_DB) {
			envAny.TURRET_DB = wrapD1Database({
				db: envAny.TURRET_DB,
				dbName: "TURRET_DB",
				requestTs: ts,
				collector: { push: (s) => d1Spans.push(s as any) },
			});
		}
	}

	const t0 = Date.now();
	let caughtError: unknown = null;

	try {
		await next();
	} catch (err) {
		caughtError = err;

		if (!shouldSkipTurretErrorCapture(request)) {
			c.executionCtx.waitUntil(
				recordWorkerError({
					env: c.env as any,
					request,
					kind: "exception",
					error: err,
				})
			);
		}

		throw err;
	} finally {
		const durationMs = Math.max(0, Date.now() - t0);
		const status = c.res?.status ?? 500;

		// Echo request ID to client for debugging.
		try {
			c.header("x-request-id", requestId);
		} catch {
			// ignore
		}

		if (
			!shouldSkipTurretErrorCapture(request) &&
			status >= 500 &&
			!caughtError
		) {
			c.executionCtx.waitUntil(
				recordWorkerError({
					env: c.env as any,
					request,
					kind: "http_5xx",
					status,
				})
			);
		}

		if (!shouldCaptureBreadcrumb) return;

		const envAny = c.env as any;
		const turretDbBinding = envAny.TURRET_DB as any;
		if (!turretDbBinding) return;

		// Non-session requests retain for 24h.
		let expiresAt = now + 24 * 60 * 60 * 1000;
		if (sessionId) {
			try {
				const turretDb = makeTurretDb(turretDbBinding);
				const session = await turretDb.query.turretSessions.findFirst({
					where: ((t: any, ops: any) =>
						ops.eq(t.sessionId, sessionId)) as unknown as never,
					columns: { retentionExpiresAt: true },
				});
				const ret = session?.retentionExpiresAt;
				if (ret instanceof Date) {
					expiresAt = ret.getTime();
				}
			} catch {
				// keep default
			}
		}

		let d1QueriesCount = 0;
		let d1QueriesTimeMs = 0;
		let d1RowsRead = 0;
		let d1RowsWritten = 0;
		let d1ErrorsCount = 0;
		for (const s of d1Spans) {
			if (s.kind === "d1.query") {
				d1QueriesCount++;
				d1QueriesTimeMs += s.durationMs;
				d1RowsRead += s.rowsRead ?? 0;
				d1RowsWritten += s.rowsWritten ?? 0;
			} else {
				d1ErrorsCount++;
			}
		}

		const errorKind = caughtError
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

		c.executionCtx.waitUntil(
			(async () => {
				try {
					const turretDb = makeTurretDb(turretDbBinding);

					await turretDb
						.insert(turretSchema.turretRequestBreadcrumbs)
						.values({
							id: crypto.randomUUID(),
							requestId,
							sessionId: sessionId ?? null,
							ts: new Date(ts),
							method: request.method,
							path: pathTemplate,
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
							errorMessage: errorMessage
								? errorMessage.slice(0, 2000)
								: null,
							extraJson: JSON.stringify({
								request_id: requestId,
								url: request.url,
							}),
							expiresAt: new Date(expiresAt),
							createdAt: new Date(Date.now()),
						});

					if (d1Spans.length > 0) {
						await turretDb
							.insert(turretSchema.turretRequestSpans)
							.values(
								d1Spans.map((s) => ({
									id: crypto.randomUUID(),
									requestId,
									ts: new Date(s.ts),
									kind: s.kind,
									db: s.db,
									durationMs: s.durationMs,
									sqlShape: s.sqlShape,
									rowsRead: s.rowsRead ?? null,
									rowsWritten: s.rowsWritten ?? null,
									errorMessage: s.errorMessage
										? s.errorMessage.slice(0, 2000)
										: null,
									extraJson: null,
									expiresAt: new Date(expiresAt),
									createdAt: new Date(Date.now()),
								}))
							);
					}

					envAny.TURRET_ANALYTICS?.writeDataPoint({
						blobs: [
							"api_request",
							request.method,
							pathTemplate,
							String(Math.floor(status / 100) * 100),
							sessionId ? "has_session" : "no_session",
						],
						doubles: [durationMs, 1],
					});
				} catch (err) {
					console.error("Turret breadcrumb capture failed", err);
				}
			})()
		);
	}
});

app.on(["GET", "POST"], "/api/auth/*", (c) =>
	createAuth(c.env, c.executionCtx).handler(c.req.raw)
);

app.route("/api", api);

app.onError((err, c) => {
	// The error has already been captured by our middleware
	// Here we just return a nice response

	console.error("Error:", err.message);

	return c.json(
		{
			error: "Internal Server Error",
			message: err.message,
			// Don't expose stack traces in production!
		},
		500
	);
});

// 404 handler
app.notFound((c) => {
	return c.json({ error: "Not Found" }, 404);
});

export type ApiType = typeof apiRoutes;

export default {
	fetch: app.fetch,
	async scheduled(
		_controller: ScheduledController,
		env: Bindings,
		ctx: ExecutionContext
	): Promise<void> {
		// At-least-once delivery: this must be safe to run multiple times.
		const now = Date.now();
		const db = (env as any).TURRET_DB;
		if (!db) return;

		const turretDb = makeTurretDb(db);
		// Delete spans first, then breadcrumbs.
		await turretDb
			.delete(turretSchema.turretRequestSpans)
			.where(sql`${turretSchema.turretRequestSpans.expiresAt} < ${now}`);
		await turretDb
			.delete(turretSchema.turretRequestBreadcrumbs)
			.where(
				sql`${turretSchema.turretRequestBreadcrumbs.expiresAt} < ${now}`
			);

		// Also cleanup old sessions/chunks/errors if you ever stop indexing them.
		ctx.waitUntil(Promise.resolve());
	},
};
