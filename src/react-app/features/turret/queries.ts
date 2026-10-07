import type { InferRequestType, InferResponseType } from "hono/client";
import {
	mutationOptions,
	queryOptions,
	type QueryClient,
} from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../../api";

const turret = apiClient.internal.turret;
const replaySession = turret["replay-session"][":id"];
const issue = turret.issue[":fingerprint"];

export type TurretReplaySessionsQuery = InferRequestType<
	(typeof turret)["replay-sessions"]["$get"]
>["query"];
export type TurretSummary = InferResponseType<typeof turret.summary.$get, 200>;
export type TurretComplianceUpdate = InferRequestType<
	typeof turret.compliance.$put
>["json"];
export type TurretIssueStatus = NonNullable<
	InferRequestType<typeof issue.$patch>["json"]["status"]
>;
export type TurretFeedbackStatus = InferRequestType<
	(typeof turret.feedback)[":id"]["$patch"]
>["json"]["status"];
export type TurretFeedbackKind = InferResponseType<
	typeof turret.feedback.$get,
	200
>["feedback"][number]["kind"];
export type TurretRequestBreadcrumb = InferResponseType<
	typeof replaySession.breadcrumbs.$get,
	200
>["breadcrumbs"][number];
export type TurretRequestSpan = InferResponseType<
	typeof replaySession.spans.$get,
	200
>["spansByRequestId"][string][number];

const turretKeys = {
	issues: ["turret", "issues"] as const,
	issue: (fingerprint: string) => ["turret", "issue", fingerprint] as const,
	feedback: ["turret", "feedback"] as const,
	sessions: ["turret", "session"] as const,
};

const turretHealthQueryOptions = queryOptions({
	queryKey: ["turret", "health"],
	queryFn: async ({ signal }) =>
		jsonOrThrow(await turret.health.$get({}, { init: { signal } })),
	retry: false,
});

const turretReplaySessionsQueryOptions = (input: TurretReplaySessionsQuery) =>
	queryOptions({
		queryKey: ["turret", "sessions", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret["replay-sessions"].$get(
					{ query: input },
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionMetaQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "meta"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.meta.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionChunksQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "chunks"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.chunks.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionErrorsQueryOptions = (sessionId: string) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "errors"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.errors.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionBreadcrumbsQueryOptions = (
	sessionId: string,
	input?: InferRequestType<typeof replaySession.breadcrumbs.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "breadcrumbs", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.breadcrumbs.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
						query: input ?? {},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionSpansQueryOptions = (
	sessionId: string,
	input?: InferRequestType<typeof replaySession.spans.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "spans", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.spans.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
						query: input ?? {},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretFeaturesQueryOptions = queryOptions({
	queryKey: ["turret", "features"],
	queryFn: async ({ signal }) =>
		jsonOrThrow(await turret.features.$get({}, { init: { signal } })),
	retry: false,
});

function turretFeaturesMutation(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: async (
			input: InferRequestType<typeof turret.features.$put>["json"]
		) => jsonOrThrow(await turret.features.$put({ json: input })),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: turretFeaturesQueryOptions.queryKey,
			}),
	});
}

const turretComplianceQueryOptions = queryOptions({
	queryKey: ["turret", "compliance"],
	queryFn: async ({ signal }) =>
		jsonOrThrow(await turret.compliance.$get({}, { init: { signal } })),
	retry: false,
});

function turretComplianceMutation(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: async (
			input: InferRequestType<typeof turret.compliance.$put>["json"]
		) => jsonOrThrow(await turret.compliance.$put({ json: input })),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: turretComplianceQueryOptions.queryKey,
			}),
	});
}

const turretDashboardUsersQueryOptions = (
	input?: InferRequestType<typeof turret.dashboard.$get>["query"]
) =>
	queryOptions({
		queryKey: ["turret", "dashboard", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret.dashboard.$get(
					{ query: input ?? {} },
					{ init: { signal } }
				)
			),
		retry: false,
	});

// The server owns the window (last hour, minute-aligned), so the key has
// no time inputs; polling advances it.
const turretSummaryQueryOptions = queryOptions({
	queryKey: ["turret", "summary"],
	queryFn: async ({ signal }) =>
		jsonOrThrow(await turret.summary.$get({}, { init: { signal } })),
	retry: false,
	staleTime: 30_000,
	refetchInterval: 60_000,
});

const turretIssuesQueryOptions = (
	input: InferRequestType<typeof turret.issues.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.issues, input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret.issues.$get({ query: input }, { init: { signal } })
			),
		retry: false,
	});

const turretIssueQueryOptions = (fingerprint: string) =>
	queryOptions({
		queryKey: turretKeys.issue(fingerprint),
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretIssueTrendQueryOptions = (
	fingerprint: string,
	input?: InferRequestType<typeof issue.trend.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "trend", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.trend.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
						query: input ?? {},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretIssueEventsQueryOptions = (
	fingerprint: string,
	input?: InferRequestType<typeof issue.events.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "events", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.events.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
						query: input ?? {},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretFeedbackQueryOptions = (
	input: InferRequestType<typeof turret.feedback.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.feedback, input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret.feedback.$get(
					{ query: input },
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretReplaySessionFeedbackQueryOptions = (
	sessionId: string,
	input?: InferRequestType<typeof replaySession.feedback.$get>["query"]
) =>
	queryOptions({
		queryKey: [...turretKeys.sessions, sessionId, "feedback", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await replaySession.feedback.$get(
					{
						param: { id: encodeURIComponent(sessionId) },
						query: input ?? {},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

function turretFeedbackStatusMutation(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: async (
			input: { id: string } & InferRequestType<
				(typeof turret.feedback)[":id"]["$patch"]
			>["json"]
		) =>
			jsonOrThrow(
				await turret.feedback[":id"].$patch({
					param: { id: encodeURIComponent(input.id) },
					json: { status: input.status },
				})
			),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: turretKeys.feedback,
				}),
				queryClient.invalidateQueries({
					queryKey: turretKeys.sessions,
				}),
			]);
		},
	});
}

function turretIssueMutation(queryClient: QueryClient, fingerprint: string) {
	return mutationOptions({
		mutationFn: async (
			update: InferRequestType<typeof issue.$patch>["json"]
		) =>
			jsonOrThrow(
				await issue.$patch({
					param: { fingerprint: encodeURIComponent(fingerprint) },
					json: update,
				})
			),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: turretKeys.issues }),
				queryClient.invalidateQueries({
					queryKey: turretKeys.issue(fingerprint),
				}),
			]);
		},
	});
}

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
	turretIssueMutation,
	turretIssuesQueryOptions,
	turretIssueQueryOptions,
	turretIssueTrendQueryOptions,
	turretIssueEventsQueryOptions,
	turretFeedbackQueryOptions,
	turretReplaySessionFeedbackQueryOptions,
	turretFeedbackStatusMutation,
};
