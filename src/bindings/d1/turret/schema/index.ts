import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const turretSessions = sqliteTable(
	"turret_sessions",
	{
		sessionId: text("session_id").primaryKey(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		endedAt: integer("ended_at", { mode: "timestamp_ms" }),
		initialUrl: text("initial_url"),
		lastUrl: text("last_url"),
		userAgent: text("user_agent"),
		country: text("country"),
		colo: text("colo"),
		journeyId: text("journey_id"),
		userId: text("user_id").notNull(),
		userEmail: text("user_email"),
		workerVersionId: text("worker_version_id"),
		workerVersionTag: text("worker_version_tag"),
		workerVersionTimestamp: text("worker_version_timestamp"),
		rrwebStartTsMs: integer("rrweb_start_ts_ms", { mode: "timestamp_ms" }),
		rrwebLastTsMs: integer("rrweb_last_ts_ms", { mode: "timestamp_ms" }),
		hasError: integer("has_error", { mode: "boolean" }).default(false).notNull(),
		captureBlocked: integer("capture_blocked", { mode: "boolean" }).default(false).notNull(),
		captureBlockedReason: text("capture_blocked_reason"),
		errorCount: integer("error_count").default(0).notNull(),
		chunkCount: integer("chunk_count").default(0).notNull(),
		policyVersion: text("policy_version").notNull(),
		retentionExpiresAt: integer("retention_expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("turret_sessions_startedAt_idx").on(table.startedAt),
		index("turret_sessions_hasError_idx").on(table.hasError),
		index("turret_sessions_captureBlocked_idx").on(table.captureBlocked),
		index("turret_sessions_retentionExpiresAt_idx").on(table.retentionExpiresAt),
		index("turret_sessions_journeyId_idx").on(table.journeyId),
		index("turret_sessions_userId_idx").on(table.userId),
		index("turret_sessions_userEmail_idx").on(table.userEmail),
		index("turret_sessions_workerVersionId_idx").on(table.workerVersionId),
		index("turret_sessions_workerVersionTag_idx").on(table.workerVersionTag),
		index("turret_sessions_rrwebStartTsMs_idx").on(table.rrwebStartTsMs),
		index("turret_sessions_rrwebLastTsMs_idx").on(table.rrwebLastTsMs),
	]
);

export const turretSessionChunks = sqliteTable(
	"turret_session_chunks",
	{
		sessionId: text("session_id").notNull(),
		seq: integer("seq").notNull(),
		r2Key: text("r2_key").notNull(),
		size: integer("size").notNull(),
		sha256: text("sha256"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("turret_chunks_sessionId_seq_idx").on(table.sessionId, table.seq),
	]
);

export const turretSessionErrors = sqliteTable(
	"turret_session_errors",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id"),
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		source: text("source").notNull(),
		message: text("message"),
		stack: text("stack"),
		fingerprint: text("fingerprint"),
		extraJson: text("extra_json"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [index("turret_errors_sessionId_ts_idx").on(table.sessionId, table.ts)]
);

export const turretRequestBreadcrumbs = sqliteTable(
	"turret_request_breadcrumbs",
	{
		id: text("id").primaryKey(),
		requestId: text("request_id").notNull(),
		sessionId: text("session_id"),
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		method: text("method").notNull(),
		path: text("path").notNull(),
		status: integer("status").notNull(),
		durationMs: integer("duration_ms").notNull(),
		rayId: text("ray_id"),
		colo: text("colo"),
		d1QueriesCount: integer("d1_queries_count").default(0).notNull(),
		d1QueriesTimeMs: integer("d1_queries_time_ms").default(0).notNull(),
		d1RowsRead: integer("d1_rows_read").default(0).notNull(),
		d1RowsWritten: integer("d1_rows_written").default(0).notNull(),
		d1ErrorsCount: integer("d1_errors_count").default(0).notNull(),
		errorKind: text("error_kind"),
		errorMessage: text("error_message"),
		extraJson: text("extra_json"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("turret_breadcrumbs_requestId_idx").on(table.requestId),
		index("turret_breadcrumbs_sessionId_ts_idx").on(table.sessionId, table.ts),
		index("turret_breadcrumbs_ts_idx").on(table.ts),
		index("turret_breadcrumbs_status_idx").on(table.status),
		index("turret_breadcrumbs_expiresAt_idx").on(table.expiresAt),
	]
);

export const turretRequestSpans = sqliteTable(
	"turret_request_spans",
	{
		id: text("id").primaryKey(),
		requestId: text("request_id").notNull(),
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		kind: text("kind").notNull(),
		db: text("db"),
		durationMs: integer("duration_ms").notNull(),
		sqlShape: text("sql_shape"),
		rowsRead: integer("rows_read"),
		rowsWritten: integer("rows_written"),
		errorMessage: text("error_message"),
		extraJson: text("extra_json"),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("turret_spans_requestId_idx").on(table.requestId),
		index("turret_spans_kind_idx").on(table.kind),
		index("turret_spans_db_idx").on(table.db),
		index("turret_spans_expiresAt_idx").on(table.expiresAt),
	]
);
