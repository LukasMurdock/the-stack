import { z } from "@hono/zod-openapi";

import { turretRequestSpanSchema } from "../../../../contracts/turret";

type D1Database = globalThis.D1Database;

const MAX_SESSION_SPANS_LIMIT = 5000;

const SESSION_SPANS_SQL = `
	SELECT
		s.id AS id,
		s.request_id AS requestId,
		s.ts AS ts,
		s.kind AS kind,
		s.db AS db,
		s.duration_ms AS durationMs,
		s.sql_shape AS sqlShape,
		s.rows_read AS rowsRead,
		s.rows_written AS rowsWritten,
		s.error_message AS errorMessage,
		s.extra_json AS extraJson,
		s.expires_at AS expiresAt,
		s.created_at AS createdAt
	FROM turret_request_spans s
	WHERE EXISTS (
		SELECT 1
		FROM turret_request_breadcrumbs b
		WHERE b.session_id = ?
			AND b.request_id = s.request_id
	)
	ORDER BY s.created_at ASC
	LIMIT ? OFFSET ?
`;

function toIsoString(value: unknown): string {
	if (typeof value === "string") {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value).toISOString();
	}
	return new Date(0).toISOString();
}

type TurretRequestSpan = z.infer<typeof turretRequestSpanSchema>;

export function normalizeSessionSpansPagination(input: {
	limitRaw?: string;
	offsetRaw?: string;
}): { limit: number; offset: number } {
	const { limitRaw, offsetRaw } = input;
	const limit = Math.max(
		1,
		Math.min(MAX_SESSION_SPANS_LIMIT, Number(limitRaw ?? "5000") || 5000)
	);
	const offset = Math.max(0, Number(offsetRaw ?? "0") || 0);
	return { limit, offset };
}

export async function loadSessionSpansGrouped(input: {
	db: D1Database;
	sessionId: string;
	limit: number;
	offset: number;
}): Promise<
	| {
			ok: true;
			spansByRequestId: Record<string, TurretRequestSpan[]>;
			hasMore: boolean;
	  }
	| { ok: false; error: "Invalid spans payload" }
> {
	const { db, sessionId, limit, offset } = input;
	const res = await db
		.prepare(SESSION_SPANS_SQL)
		.bind(sessionId, limit + 1, offset)
		.all();

	const rawRows = (res.results ?? []) as Array<Record<string, unknown>>;
	const hasMore = rawRows.length > limit;
	const candidateRows = hasMore ? rawRows.slice(0, limit) : rawRows;
	const parsedSpans = z.array(turretRequestSpanSchema).safeParse(
		candidateRows.map((row) => ({
			id: String(row.id ?? ""),
			requestId: String(row.requestId ?? ""),
			ts: toIsoString(row.ts),
			kind: String(row.kind ?? ""),
			db: row.db == null ? null : String(row.db),
			durationMs: Number(row.durationMs ?? 0),
			sqlShape: row.sqlShape == null ? null : String(row.sqlShape),
			rowsRead: row.rowsRead == null ? null : Number(row.rowsRead),
			rowsWritten:
				row.rowsWritten == null ? null : Number(row.rowsWritten),
			errorMessage:
				row.errorMessage == null ? null : String(row.errorMessage),
			extraJson: row.extraJson == null ? null : String(row.extraJson),
			expiresAt: toIsoString(row.expiresAt),
			createdAt: toIsoString(row.createdAt),
		}))
	);

	if (!parsedSpans.success) {
		return { ok: false, error: "Invalid spans payload" };
	}

	const spansByRequestId: Record<string, TurretRequestSpan[]> = {};
	for (const span of parsedSpans.data) {
		const requestId = span.requestId;
		if (!spansByRequestId[requestId]) spansByRequestId[requestId] = [];
		spansByRequestId[requestId].push(span);
	}

	return { ok: true, spansByRequestId, hasMore };
}
