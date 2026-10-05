import { queryOptions } from "@tanstack/react-query";
import {
	getFeatures,
	getCompliance,
	getReplaySessionBreadcrumbs,
	getReplaySessionChunks,
	getReplaySessionErrors,
	getReplaySessionSpans,
	getReplaySessionMeta,
	listReplaySessions,
	setCompliance,
	setFeatures,
	turretHealth,
	getDashboardUsers,
	getTurretSummary,
	listIssues,
	getIssue,
	getIssueTrend,
	getIssueEvents,
	listFeedback,
	listReplaySessionFeedback,
	patchFeedbackStatus,
	type TurretFeatures,
	type TurretCompliancePolicy,
	type TurretReplaySessionsQuery,
	type TurretIssueStatus,
	type TurretFeedbackKind,
	type TurretFeedbackStatus,
} from "../lib/turretApi";

const turretHealthQueryOptions = queryOptions({
	queryKey: ["turret", "health"],
	queryFn: turretHealth,
	retry: false,
});

const turretReplaySessionsQueryOptions = (input: TurretReplaySessionsQuery) =>
	queryOptions({
		queryKey: ["turret", "sessions", input],
		queryFn: () => listReplaySessions(input),
		retry: false,
	});

const turretReplaySessionMetaQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "meta"],
		queryFn: () => getReplaySessionMeta(sessionId),
		retry: false,
	});

const turretReplaySessionChunksQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "chunks"],
		queryFn: () => getReplaySessionChunks(sessionId),
		retry: false,
	});

const turretReplaySessionErrorsQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "errors"],
		queryFn: () => getReplaySessionErrors(sessionId),
		retry: false,
	});

const turretReplaySessionBreadcrumbsQueryOptions = (
	sessionId: string,
	input?: { limit?: number; offset?: number }
) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "breadcrumbs", input],
		queryFn: () => getReplaySessionBreadcrumbs(sessionId, input),
		retry: false,
	});

const turretReplaySessionSpansQueryOptions = (
	sessionId: string,
	input?: { limit?: number; offset?: number }
) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "spans", input],
		queryFn: () => getReplaySessionSpans(sessionId, input),
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

const turretComplianceMutation = (next: Partial<TurretCompliancePolicy>) =>
	setCompliance(next);

const turretDashboardUsersQueryOptions = (input?: { to?: number }) =>
	queryOptions({
		queryKey: ["turret", "dashboard", input],
		queryFn: () => getDashboardUsers(input),
		retry: false,
	});

// The server owns the window (last hour, minute-aligned), so the key has
// no time inputs; polling advances it.
const turretSummaryQueryOptions = queryOptions({
	queryKey: ["turret", "summary"],
	queryFn: getTurretSummary,
	retry: false,
	staleTime: 30_000,
	refetchInterval: 60_000,
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

const turretIssueEventsQueryOptions = (
	fingerprint: string,
	input?: { limit?: number; offset?: number }
) =>
	queryOptions({
		queryKey: ["turret", "issue", fingerprint, "events", input],
		queryFn: () => getIssueEvents(fingerprint, input),
		retry: false,
	});

const turretFeedbackQueryOptions = (input: {
	status?: TurretFeedbackStatus;
	kind?: TurretFeedbackKind;
	q?: string;
	from?: number;
	to?: number;
	limit?: number;
	offset?: number;
	sessionId?: string;
	userId?: string;
}) =>
	queryOptions({
		queryKey: ["turret", "feedback", input],
		queryFn: () => listFeedback(input),
		retry: false,
	});

const turretReplaySessionFeedbackQueryOptions = (
	sessionId: string,
	input?: { limit?: number; offset?: number }
) =>
	queryOptions({
		queryKey: ["turret", "session", sessionId, "feedback", input],
		queryFn: () => listReplaySessionFeedback(sessionId, input),
		retry: false,
	});

const turretFeedbackStatusMutation = (input: {
	id: string;
	status: TurretFeedbackStatus;
}) => patchFeedbackStatus(input);

export {
	turretHealthQueryOptions,
	turretReplaySessionsQueryOptions,
	turretReplaySessionMetaQueryOptions,
	turretReplaySessionChunksQueryOptions,
	turretReplaySessionErrorsQueryOptions,
	turretReplaySessionBreadcrumbsQueryOptions,
	turretReplaySessionSpansQueryOptions,
	turretFeaturesQueryOptions,
	turretFeaturesMutation,
	turretComplianceQueryOptions,
	turretComplianceMutation,
	turretDashboardUsersQueryOptions,
	turretSummaryQueryOptions,
	turretIssuesQueryOptions,
	turretIssueQueryOptions,
	turretIssueTrendQueryOptions,
	turretIssueEventsQueryOptions,
	turretFeedbackQueryOptions,
	turretReplaySessionFeedbackQueryOptions,
	turretFeedbackStatusMutation,
};
