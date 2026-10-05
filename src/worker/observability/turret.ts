import { eq, sql } from "drizzle-orm";
import { makeTurretDb } from "../../bindings/d1/turret/db";
import * as turretSchema from "../../bindings/d1/turret/schema";
import type { Bindings } from "../index";
import type { D1Span } from "./d1Proxy";
import {
	fingerprintException,
	fingerprintHttp5xx,
	normalizeApiPath,
} from "../turret/fingerprinting";
export function shouldSkipTurretErrorCapture(req: Request): boolean {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/")) return true;
	if (url.pathname.startsWith("/api/turret/session/")) return true;
	if (url.pathname.startsWith("/api/turret/replay-session/")) return true;
	if (url.pathname.startsWith("/api/internal/turret/")) return true;
	return false;
}

export function shouldSkipTurretBreadcrumbCapture(req: Request): boolean {
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

export async function recordWorkerError(args: {
	env: Bindings & {
		TURRET_DB?: D1Database;
		TURRET_ANALYTICS?: {
			writeDataPoint(input: { blobs: string[]; doubles: number[] }): void;
		};
	};
	request: Request;
	requestId: string;
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
		const now = Date.now();
		let expiresAt = now + 24 * 60 * 60 * 1000;
		if (sessionId) {
			try {
				const turretDb = makeTurretDb(dbBinding);
				const session = await turretDb.query.turretSessions.findFirst({
					where: (t, ops) => ops.eq(t.sessionId, sessionId),
					columns: { retentionExpiresAt: true },
				});
				const ret = session?.retentionExpiresAt;
				if (ret instanceof Date) expiresAt = ret.getTime();
			} catch {
				// keep default
			}
		}

		const url = new URL(args.request.url);
		const pathTemplate = normalizeApiPath(url.pathname);
		let fp: string | null = null;
		try {
			fp =
				args.kind === "http_5xx"
					? await fingerprintHttp5xx({
							method: args.request.method,
							pathTemplate,
							status: args.status ?? 500,
						})
					: await fingerprintException({
							platform: "worker",
							message,
							stack,
							method: args.request.method,
							pathTemplate,
						});
		} catch {
			fp = null;
		}

		const turretDb = makeTurretDb(dbBinding);
		await turretDb.insert(turretSchema.turretSessionErrors).values({
			id: crypto.randomUUID(),
			sessionId: sessionId ?? null,
			ts: new Date(ts),
			source: "worker",
			message: message ? message.slice(0, 2000) : null,
			stack: stack ? stack.slice(0, 20000) : null,
			fingerprint: fp ? fp.slice(0, 256) : null,
			extraJson: JSON.stringify({
				kind: args.kind,
				status: args.status,
				path: pathTemplate,
				request_id: args.requestId,
				worker_version: args.env.CF_VERSION_METADATA?.id,
				method: args.request.method,
				ray_id: rayId,
				colo,
			}),
			expiresAt: new Date(expiresAt),
			createdAt: new Date(now),
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
		console.error(
			{
				action: "turret.error_capture_failed",
				requestId: args.requestId,
			},
			err
		);
	}
}

export type BreadcrumbObservation = {
	env: Bindings;
	request: Request;
	requestId: string;
	sessionId: string | null;
	ts: number;
	pathTemplate: string;
	status: number;
	durationMs: number;
	rayId: string | null;
	colo: string | null;
	d1QueriesCount: number;
	d1QueriesTimeMs: number;
	d1RowsRead: number;
	d1RowsWritten: number;
	d1ErrorsCount: number;
	errorKind: "exception" | "http_5xx" | null;
	errorMessage: string | null;
	d1Spans: D1Span[];
};

export async function recordBreadcrumb(
	args: BreadcrumbObservation
): Promise<void> {
	const {
		env,
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
	} = args;
	const turretDbBinding = env.TURRET_DB;
	if (!turretDbBinding) return;
	const now = Date.now();
	try {
		// Non-session requests retain for 24h.
		let expiresAt = now + 24 * 60 * 60 * 1000;
		if (sessionId) {
			try {
				const turretDb = makeTurretDb(turretDbBinding);
				const session = await turretDb.query.turretSessions.findFirst({
					where: (t, ops) => ops.eq(t.sessionId, sessionId),
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

		const turretDb = makeTurretDb(turretDbBinding);

		await turretDb.insert(turretSchema.turretRequestBreadcrumbs).values({
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
			errorMessage: errorMessage ? errorMessage.slice(0, 2000) : null,
			extraJson: JSON.stringify({
				request_id: requestId,
				path: pathTemplate,
				worker_version: env.CF_VERSION_METADATA?.id,
			}),
			expiresAt: new Date(expiresAt),
			createdAt: new Date(Date.now()),
		});

		if (d1Spans.length > 0) {
			// D1 permits 100 bound parameters per statement. Each span has 13.
			for (let offset = 0; offset < d1Spans.length; offset += 7) {
				await turretDb.insert(turretSchema.turretRequestSpans).values(
					d1Spans.slice(offset, offset + 7).map((s) => ({
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
		}

		env.TURRET_ANALYTICS?.writeDataPoint({
			blobs: [
				"api_request",
				request.method,
				pathTemplate,
				String(Math.floor(status / 100) * 100),
				sessionId ? "has_session" : "no_session",
			],
			doubles: [durationMs, 1],
		});
	} catch (error) {
		console.error({ action: "turret.breadcrumb_failed", requestId }, error);
	}
}
