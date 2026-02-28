import { jsonOrThrow } from "./apiClient";

async function internalTurretFetch(
	path: string,
	init?: RequestInit
): Promise<Response> {
	return fetch(`/api/internal/turret${path}`, {
		credentials: "include",
		...init,
	});
}

export type TurretSessionsQuery = {
	hasError?: boolean;
	journeyId?: string;
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
	journeyId: string | null;
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
	expiresAt: string | null;
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

export type TurretCompliancePolicy = {
	version: string;
	retentionDays: number;
	rrweb: { maskAllInputs?: boolean } & Record<string, unknown>;
	console: { enabled?: boolean } & Record<string, unknown>;
};

export type TurretComplianceResponse = {
	policy: TurretCompliancePolicy;
};

export type TurretWeeklyPoint = {
	weekStartMs: number;
	value: number;
};

export type TurretWeeklyPointNullable = {
	weekStartMs: number;
	value: number | null;
};

export type TurretDashboardUsersResponse = {
	activeUsers24h: number;
	activeUsersPrev24h: number;
	activeUsersDeltaPct: number | null;

	newUsers24h: number;

	totalUsersNow: number;
	totalUsersPrevWeek: number;
	totalUsersDeltaPct: number | null;

	seriesTotalUsersWeekly: TurretWeeklyPoint[];
	seriesNewUsersWeekly: TurretWeeklyPoint[];
	seriesNewUserRetentionWeeklyPct: TurretWeeklyPointNullable[];

	newUsersDeltaPctWoW: number | null;
	retentionDeltaPctWoW: number | null;
};

export type TurretIssueStatus = "open" | "resolved" | "ignored";

export type TurretIssueSample = {
	errorId: string | null;
	sessionId: string | null;
	source: string | null;
	message: string | null;
	ts: number | null;
};

export type TurretIssueListItem = {
	fingerprint: string;
	status: TurretIssueStatus;
	title: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
	occurrences: number;
	sessionsAffected: number;
	sample: TurretIssueSample;
};

export type TurretIssuesListResponse = {
	issues: TurretIssueListItem[];
	limit: number;
	offset: number;
};

export type TurretIssueDetail = {
	fingerprint: string;
	status: TurretIssueStatus;
	title: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
	occurrencesTotal: number;
	sessionsAffectedTotal: number;
	sample: TurretIssueSample;
};

export type TurretIssueDetailResponse = {
	issue: TurretIssueDetail;
};

export type TurretIssueTrendPoint = {
	bucketStartMs: number;
	count: number;
};

export type TurretIssueTrendResponse = {
	bucket: "hour" | "day";
	from: number;
	to: number;
	points: TurretIssueTrendPoint[];
};

export type TurretIssueEvent = {
	id: string;
	sessionId: string | null;
	ts: number;
	source: string;
	message: string | null;
	stack: string | null;
	fingerprint: string | null;
	extraJson: string | null;
	expiresAt: number | null;
	createdAt: number;
};

export type TurretIssueEventsResponse = {
	events: TurretIssueEvent[];
	limit: number;
	offset: number;
};

export type TurretIssueUpdate = {
	status?: TurretIssueStatus;
	title?: string | null;
};

export type TurretFeedbackKind = "bug" | "idea" | "praise" | "other";
export type TurretFeedbackStatus = "open" | "triaged" | "resolved";

export type TurretFeedbackItem = {
	id: string;
	sessionId: string;
	userId: string;
	userEmail: string | null;
	ts: number;
	url: string | null;
	kind: TurretFeedbackKind;
	message: string;
	contact: string | null;
	status: TurretFeedbackStatus;
	createdAt: number;
	updatedAt: number;
};

export type TurretFeedbackListResponse = {
	feedback: TurretFeedbackItem[];
	limit: number;
	offset: number;
};

async function turretHealth(): Promise<{ ok: true }> {
	const res = await internalTurretFetch("/health");
	return jsonOrThrow(res) as Promise<{ ok: true }>;
}

async function listSessions(
	query: TurretSessionsQuery
): Promise<TurretSessionsResponse> {
	const url = new URL(
		"/api/internal/turret/sessions",
		window.location.origin
	);
	if (query.hasError) url.searchParams.set("hasError", "1");
	if (query.journeyId) url.searchParams.set("journeyId", query.journeyId);
	if (query.q) url.searchParams.set("q", query.q);
	if (query.from) url.searchParams.set("from", String(query.from));
	if (query.to) url.searchParams.set("to", String(query.to));
	url.searchParams.set("limit", String(query.limit ?? 50));
	url.searchParams.set("offset", String(query.offset ?? 0));

	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretSessionsResponse>(res);
}

async function getSessionMeta(sessionId: string): Promise<TurretMetaResponse> {
	const res = await internalTurretFetch(
		`/session/${encodeURIComponent(sessionId)}/meta`
	);
	return jsonOrThrow<TurretMetaResponse>(res);
}

async function getSessionChunks(
	sessionId: string
): Promise<TurretChunksResponse> {
	const res = await internalTurretFetch(
		`/session/${encodeURIComponent(sessionId)}/chunks`
	);
	return jsonOrThrow<TurretChunksResponse>(res);
}

async function getSessionErrors(
	sessionId: string
): Promise<TurretErrorsResponse> {
	const res = await internalTurretFetch(
		`/session/${encodeURIComponent(sessionId)}/errors`
	);
	return jsonOrThrow<TurretErrorsResponse>(res);
}

async function getSessionBreadcrumbs(
	sessionId: string,
	opts?: { limit?: number; offset?: number }
): Promise<TurretBreadcrumbsResponse> {
	const url = new URL(
		`/api/internal/turret/session/${encodeURIComponent(sessionId)}/breadcrumbs`,
		window.location.origin
	);
	url.searchParams.set("limit", String(opts?.limit ?? 200));
	url.searchParams.set("offset", String(opts?.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretBreadcrumbsResponse>(res);
}

async function getRequestSpans(
	requestId: string
): Promise<TurretSpansResponse> {
	const res = await internalTurretFetch(
		`/request/${encodeURIComponent(requestId)}/spans`
	);
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

async function setFeatures(
	input: TurretFeatures
): Promise<TurretFeaturesResponse> {
	const res = await internalTurretFetch("/features", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return jsonOrThrow<TurretFeaturesResponse>(res);
}

async function getCompliance(): Promise<TurretComplianceResponse> {
	const res = await internalTurretFetch("/compliance");
	return jsonOrThrow<TurretComplianceResponse>(res);
}

async function setCompliance(
	input: Partial<TurretCompliancePolicy>
): Promise<TurretComplianceResponse> {
	const res = await internalTurretFetch("/compliance", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	return jsonOrThrow<TurretComplianceResponse>(res);
}

async function getDashboardUsers(opts?: {
	to?: number;
}): Promise<TurretDashboardUsersResponse> {
	const url = new URL(
		"/api/internal/turret/dashboard",
		window.location.origin
	);
	if (opts?.to) url.searchParams.set("to", String(opts.to));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretDashboardUsersResponse>(res);
}

async function listIssues(input: {
	status?: TurretIssueStatus;
	q?: string;
	from?: number;
	to?: number;
	limit?: number;
	offset?: number;
}): Promise<TurretIssuesListResponse> {
	const url = new URL("/api/internal/turret/issues", window.location.origin);
	if (input.status) url.searchParams.set("status", input.status);
	if (input.q) url.searchParams.set("q", input.q);
	if (input.from) url.searchParams.set("from", String(input.from));
	if (input.to) url.searchParams.set("to", String(input.to));
	url.searchParams.set("limit", String(input.limit ?? 50));
	url.searchParams.set("offset", String(input.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretIssuesListResponse>(res);
}

async function listFeedback(input: {
	status?: TurretFeedbackStatus;
	kind?: TurretFeedbackKind;
	q?: string;
	from?: number;
	to?: number;
	limit?: number;
	offset?: number;
	sessionId?: string;
	userId?: string;
}): Promise<TurretFeedbackListResponse> {
	const url = new URL(
		"/api/internal/turret/feedback",
		window.location.origin
	);
	if (input.status) url.searchParams.set("status", input.status);
	if (input.kind) url.searchParams.set("kind", input.kind);
	if (input.q) url.searchParams.set("q", input.q);
	if (input.sessionId) url.searchParams.set("sessionId", input.sessionId);
	if (input.userId) url.searchParams.set("userId", input.userId);
	if (input.from) url.searchParams.set("from", String(input.from));
	if (input.to) url.searchParams.set("to", String(input.to));
	url.searchParams.set("limit", String(input.limit ?? 50));
	url.searchParams.set("offset", String(input.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretFeedbackListResponse>(res);
}

async function listSessionFeedback(
	sessionId: string,
	input?: { limit?: number; offset?: number }
): Promise<TurretFeedbackListResponse> {
	const url = new URL(
		`/api/internal/turret/session/${encodeURIComponent(sessionId)}/feedback`,
		window.location.origin
	);
	url.searchParams.set("limit", String(input?.limit ?? 50));
	url.searchParams.set("offset", String(input?.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretFeedbackListResponse>(res);
}

async function patchFeedbackStatus(input: {
	id: string;
	status: TurretFeedbackStatus;
}): Promise<{ ok: true }> {
	const res = await internalTurretFetch(
		`/feedback/${encodeURIComponent(input.id)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: input.status }),
		}
	);
	return jsonOrThrow<{ ok: true }>(res);
}

async function getIssue(
	fingerprint: string
): Promise<TurretIssueDetailResponse> {
	const res = await internalTurretFetch(
		`/issue/${encodeURIComponent(fingerprint)}`
	);
	return jsonOrThrow<TurretIssueDetailResponse>(res);
}

async function getIssueTrend(
	fingerprint: string,
	input?: { from?: number; to?: number; bucket?: "hour" | "day" }
): Promise<TurretIssueTrendResponse> {
	const url = new URL(
		`/api/internal/turret/issue/${encodeURIComponent(fingerprint)}/trend`,
		window.location.origin
	);
	if (input?.from) url.searchParams.set("from", String(input.from));
	if (input?.to) url.searchParams.set("to", String(input.to));
	if (input?.bucket) url.searchParams.set("bucket", input.bucket);
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretIssueTrendResponse>(res);
}

async function getIssueEvents(
	fingerprint: string,
	input?: { limit?: number; offset?: number }
): Promise<TurretIssueEventsResponse> {
	const url = new URL(
		`/api/internal/turret/issue/${encodeURIComponent(fingerprint)}/events`,
		window.location.origin
	);
	url.searchParams.set("limit", String(input?.limit ?? 50));
	url.searchParams.set("offset", String(input?.offset ?? 0));
	const res = await fetch(url.toString(), { credentials: "include" });
	return jsonOrThrow<TurretIssueEventsResponse>(res);
}

async function patchIssue(
	fingerprint: string,
	update: TurretIssueUpdate
): Promise<TurretIssueDetailResponse> {
	const res = await internalTurretFetch(
		`/issue/${encodeURIComponent(fingerprint)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		}
	);
	return jsonOrThrow<TurretIssueDetailResponse>(res);
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
	getCompliance,
	setCompliance,
	getDashboardUsers,
	listIssues,
	getIssue,
	getIssueTrend,
	getIssueEvents,
	patchIssue,
	listFeedback,
	listSessionFeedback,
	patchFeedbackStatus,
};
