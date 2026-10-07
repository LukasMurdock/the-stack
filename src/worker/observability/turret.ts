import { persistError } from "../turret/errors";
import type { TurretCorrelation } from "../../contracts/turret-correlation";
import { readTelemetryExpiry } from "../turret/retention";
import { getRequestLocation } from "../../lib/cloudflareRequest";
import { makeTurretDb } from "../../bindings/d1/turret/db";
import * as turretSchema from "../../bindings/d1/turret/schema";
import type { Bindings } from "../index";
import type { D1Span } from "./d1Proxy";
import type { RouteLabel } from "./route-label";
import {
	fingerprintException,
	fingerprintHttp5xx,
} from "../turret/fingerprinting";
export async function recordWorkerError(args: {
	env: Bindings & {
		TURRET_DB?: D1Database;
		TURRET_ANALYTICS?: {
			writeDataPoint(input: { blobs: string[]; doubles: number[] }): void;
		};
	};
	request: Request;
	requestId: string;
	pathTemplate: RouteLabel;
	correlation: TurretCorrelation;
	kind: "exception" | "http_5xx";
	status?: number;
	error?: unknown;
}): Promise<void> {
	const dbBinding = args.env.TURRET_DB;
	if (!dbBinding) return;

	const { sessionId, ts } = args.correlation;
	const rayId = args.request.headers.get("cf-ray") ?? undefined;
	const colo = getRequestLocation(args.request).colo;

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
		const turretDb = makeTurretDb(dbBinding);

		const pathTemplate = args.pathTemplate;
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

		await persistError(
			turretDb,
			{
				sessionId,
				ts: new Date(ts),
				source: "worker",
				message,
				stack,
				fingerprint: fp,
				deploymentId: args.env.CF_VERSION_METADATA?.id || null,
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
			},
			now
		);

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
	pathTemplate: RouteLabel;
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
		const turretDb = makeTurretDb(turretDbBinding);
		const expiresAt = await readTelemetryExpiry(turretDb, sessionId, now);
		const breadcrumbId = crypto.randomUUID();

		await turretDb.insert(turretSchema.turretRequestBreadcrumbs).values({
			id: breadcrumbId,
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
			// Every field is bound, including nulls, so a single generated row
			// determines how many spans fit D1's 100-parameter statement limit.
			const rows = d1Spans.map((s) => ({
				id: crypto.randomUUID(),
				breadcrumbId,
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
				createdAt: new Date(now),
			}));
			const parametersPerSpan = turretDb
				.insert(turretSchema.turretRequestSpans)
				.values(rows[0])
				.toSQL().params.length;
			const batchSize = Math.floor(100 / parametersPerSpan);
			if (batchSize < 1)
				throw new Error("A replay span exceeds D1's parameter limit.");
			for (let offset = 0; offset < rows.length; offset += batchSize)
				await turretDb
					.insert(turretSchema.turretRequestSpans)
					.values(rows.slice(offset, offset + batchSize));
		}
	} catch (error) {
		console.error({ action: "turret.breadcrumb_failed", requestId }, error);
	}
}
