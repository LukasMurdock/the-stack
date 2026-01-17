import { jsonOrThrow } from "./apiClient";

async function internalTurretFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`/api/internal/turret${path}`, {
		credentials: "include",
		...init,
	});
}

export type TurretSessionsQuery = {
	hasError?: boolean;
	q?: string;
	from?: number;
	to?: number;
	limit?: number;
	offset?: number;
};

export type TurretSession = {
	sessionId: string;
	userId: string;
	userEmail: string | null;
	workerVersionId: string | null;
	workerVersionTag: string | null;
	workerVersionTimestamp: string | null;
	rrwebStartTsMs: string | null;
	rrwebLastTsMs: string | null;
	startedAt: string;

	endedAt: string | null;
	initialUrl: string | null;
	lastUrl: string | null;
	userAgent: string | null;
	country: string | null;
	colo: string | null;
	hasError: boolean;
	captureBlocked: boolean;
	captureBlockedReason: string | null;
	errorCount: number;
	chunkCount: number;
	policyVersion: string;
	retentionExpiresAt: string;
	createdAt: string;
	updatedAt: string;
};

export type TurretSessionsResponse = {
	sessions: TurretSession[];
	limit: number;
	offset: number;
};

export type TurretSessionChunk = {
	sessionId: string;
	seq: number;
	r2Key: string;
	size: number;
	sha256: string | null;
	createdAt: string;
};

export type TurretChunksResponse = {
	chunks: TurretSessionChunk[];
};

export type TurretSessionError = {
	id: string;
	sessionId: string | null;
	ts: string;
	source: string;
	message: string | null;
	stack: string | null;
	fingerprint: string | null;
	extraJson: string | null;
	createdAt: string;
};

export type TurretErrorsResponse = {
	errors: TurretSessionError[];
};

export type TurretRequestBreadcrumb = {
	id: string;
	requestId: string;
	sessionId: string | null;
	ts: string;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	rayId: string | null;
	colo: string | null;
	d1QueriesCount: number;
	d1QueriesTimeMs: number;
	d1RowsRead: number;
	d1RowsWritten: number;
	d1ErrorsCount: number;
	errorKind: string | null;
	errorMessage: string | null;
	extraJson: string | null;
	expiresAt: string;
	createdAt: string;
};

export type TurretBreadcrumbsResponse = {
	breadcrumbs: TurretRequestBreadcrumb[];
	limit: number;
	offset: number;
};

export type TurretRequestSpan = {
	id: string;
	requestId: string;
	ts: string;
	kind: string;
	db: string | null;
	durationMs: number;
	sqlShape: string | null;
	rowsRead: number | null;
	rowsWritten: number | null;
	errorMessage: string | null;
	extraJson: string | null;
	expiresAt: string;
	createdAt: string;
};

export type TurretSpansResponse = {
	spans: TurretRequestSpan[];
};

export type TurretMetaResponse = {
	session: TurretSession;
};

export type TurretFeatures = {
	storeUserEmail: boolean;
};

export type TurretFeaturesResponse = {
	features: TurretFeatures;
};

async function turretHealth(): Promise<{ ok: true }> {
	const res = await internalTurretFetch("/health");
	return jsonOrThrow(res) as Promise<{ ok: true }>;
}

async function listSessions(query: TurretSessionsQuery): Promise<TurretSessionsResponse> {
	const url = new URL("/api/internal/turret/sessions", window.location.origin);
	if (query.hasError) url.searchParams.set("hasError", "1");
	if (query.q) url.searchParams.set("q", query.q);
	if (query.from) url.searchParams.set("from", String(query.from));
	if (query.to) url.searchParams.set("to", String(query.to));
	url.searchParams.set("limit", String(query.limit ?? 50));
	url.searchParams.set("offset", String(query.offset ?? 0));

	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretSessionsResponse>(res);
}

async function getSessionMeta(sessionId: string): Promise<TurretMetaResponse> {
	const res = await internalTurretFetch(`/session/${encodeURIComponent(sessionId)}/meta`);
	return jsonOrThrow<TurretMetaResponse>(res);
}

async function getSessionChunks(sessionId: string): Promise<TurretChunksResponse> {
	const res = await internalTurretFetch(`/session/${encodeURIComponent(sessionId)}/chunks`);
	return jsonOrThrow<TurretChunksResponse>(res);
}

async function getSessionErrors(sessionId: string): Promise<TurretErrorsResponse> {
	const res = await internalTurretFetch(`/session/${encodeURIComponent(sessionId)}/errors`);
	return jsonOrThrow<TurretErrorsResponse>(res);
}

async function getSessionBreadcrumbs(
	sessionId: string,
	opts?: { limit?: number; offset?: number }
): Promise<TurretBreadcrumbsResponse> {
	const url = new URL(`/api/internal/turret/session/${encodeURIComponent(sessionId)}/breadcrumbs`, window.location.origin);
	url.searchParams.set("limit", String(opts?.limit ?? 200));
	url.searchParams.set("offset", String(opts?.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretBreadcrumbsResponse>(res);
}

async function getRequestSpans(requestId: string): Promise<TurretSpansResponse> {
	const res = await internalTurretFetch(`/request/${encodeURIComponent(requestId)}/spans`);
	return jsonOrThrow<TurretSpansResponse>(res);
}

export type TurretReplayChunkPayload = {
	seq: number;
	events: unknown[];
	ts_start?: number;
	ts_end?: number;
};

async function getSessionChunk(
	sessionId: string,
	seq: number,
	options?: { signal?: AbortSignal }
): Promise<TurretReplayChunkPayload> {
	const res = await internalTurretFetch(
		`/session/${encodeURIComponent(sessionId)}/chunk/${encodeURIComponent(String(seq))}`,
		{ signal: options?.signal }
	);
	return jsonOrThrow<TurretReplayChunkPayload>(res);
}

async function getFeatures(): Promise<TurretFeaturesResponse> {
	const res = await internalTurretFetch("/features");
	return jsonOrThrow<TurretFeaturesResponse>(res);
}

async function setFeatures(input: TurretFeatures): Promise<TurretFeaturesResponse> {
	const res = await internalTurretFetch("/features", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return jsonOrThrow<TurretFeaturesResponse>(res);
}

export {
	turretHealth,
	listSessions,
	getSessionMeta,
	getSessionChunks,
	getSessionChunk,
	getSessionErrors,
	getSessionBreadcrumbs,
	getRequestSpans,
	getFeatures,
	setFeatures,
};
