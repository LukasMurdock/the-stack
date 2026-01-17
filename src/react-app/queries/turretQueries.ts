import { queryOptions } from "@tanstack/react-query";
import {
	getFeatures,
	getSessionBreadcrumbs,
	getSessionChunks,
	getSessionErrors,
	getSessionMeta,
	getRequestSpans,
	listSessions,
	setFeatures,
	turretHealth,
	type TurretFeatures,
	type TurretSessionsQuery,
} from "../lib/turretApi";

const turretHealthQueryOptions = queryOptions({
	queryKey: ["turret", "health"],
	queryFn: turretHealth,
	retry: false,
});

const turretSessionsQueryOptions = (input: TurretSessionsQuery) =>
	queryOptions({
		queryKey: ["turret", "sessions", input],
		queryFn: () => listSessions(input),
		retry: false,
	});

const turretSessionMetaQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "meta"],
		queryFn: () => getSessionMeta(sessionId),
		retry: false,
	});

const turretSessionChunksQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "chunks"],
		queryFn: () => getSessionChunks(sessionId),
		retry: false,
	});

const turretSessionErrorsQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "errors"],
		queryFn: () => getSessionErrors(sessionId),
		retry: false,
	});

const turretSessionBreadcrumbsQueryOptions = (sessionId: string, input?: { limit?: number; offset?: number }) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "breadcrumbs", input],
		queryFn: () => getSessionBreadcrumbs(sessionId, input),
		retry: false,
	});

const turretRequestSpansQueryOptions = (requestId: string) =>
	queryOptions({
		queryKey: ["turret", "request", requestId, "spans"],
		queryFn: () => getRequestSpans(requestId),
		retry: false,
	});

const turretFeaturesQueryOptions = queryOptions({
	queryKey: ["turret", "features"],
	queryFn: getFeatures,
	retry: false,
});

const turretFeaturesMutation = (next: TurretFeatures) => setFeatures(next);

export {
	turretHealthQueryOptions,
	turretSessionsQueryOptions,
	turretSessionMetaQueryOptions,
	turretSessionChunksQueryOptions,
	turretSessionErrorsQueryOptions,
	turretSessionBreadcrumbsQueryOptions,
	turretRequestSpansQueryOptions,
	turretFeaturesQueryOptions,
	turretFeaturesMutation,
};
