import { queryOptions } from "@tanstack/react-query";
import {
	getFeatures,
	getCompliance,
	getSessionBreadcrumbs,
	getSessionChunks,
	getSessionErrors,
	getSessionMeta,
	getRequestSpans,
	listSessions,
	setCompliance,
	setFeatures,
	turretHealth,
	getDashboardUsers,
	getUptime,
	listIssues,
	getIssue,
	getIssueTrend,
	getIssueEvents,
	type TurretFeatures,
	type TurretCompliancePolicy,
	type TurretSessionsQuery,
	type TurretIssueStatus,
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

const turretComplianceQueryOptions = queryOptions({
	queryKey: ["turret", "compliance"],
	queryFn: getCompliance,
	retry: false,
});

const turretComplianceMutation = (next: Partial<TurretCompliancePolicy>) => setCompliance(next);

const turretDashboardUsersQueryOptions = (input?: { to?: number }) =>
	queryOptions({
		queryKey: ["turret", "dashboard", input],
		queryFn: () => getDashboardUsers(input),
		retry: false,
	});

const turretIssuesQueryOptions = (input: {
	status?: TurretIssueStatus;
	q?: string;
	from?: number;
	to?: number;
	limit?: number;
	offset?: number;
}) =>
	queryOptions({
		queryKey: ["turret", "issues", input],
		queryFn: () => listIssues(input),
		retry: false,
	});

const turretIssueQueryOptions = (fingerprint: string) =>
	queryOptions({
		queryKey: ["turret", "issue", fingerprint],
		queryFn: () => getIssue(fingerprint),
		retry: false,
	});

const turretIssueTrendQueryOptions = (
	fingerprint: string,
	input?: { from?: number; to?: number; bucket?: "hour" | "day" }
) =>
	queryOptions({
		queryKey: ["turret", "issue", fingerprint, "trend", input],
		queryFn: () => getIssueTrend(fingerprint, input),
		retry: false,
	});

const turretIssueEventsQueryOptions = (fingerprint: string, input?: { limit?: number; offset?: number }) =>
	queryOptions({
		queryKey: ["turret", "issue", fingerprint, "events", input],
		queryFn: () => getIssueEvents(fingerprint, input),
		retry: false,
	});

const turretUptimeQueryOptions = queryOptions({
	queryKey: ["turret", "uptime"],
	queryFn: getUptime,
	retry: false,
});

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
	turretComplianceQueryOptions,
	turretComplianceMutation,
	turretDashboardUsersQueryOptions,
	turretUptimeQueryOptions,
	turretIssuesQueryOptions,
	turretIssueQueryOptions,
	turretIssueTrendQueryOptions,
	turretIssueEventsQueryOptions,
};
