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
export type TurretIssueOccurrence = InferResponseType<
	(typeof issue.event)[":errorId"]["$get"],
	200
>;
export type TurretReplaySessionError = InferResponseType<
	typeof replaySession.errors.$get,
	200
>["errors"][number];
export type TurretReplaySessionFeedback = InferResponseType<
	typeof replaySession.feedback.$get,
	200
>["feedback"][number];
export type TurretIssueReport = InferResponseType<
	typeof issue.reports.$get,
	200
>["reports"][number];
export type TurretIssueActivity = InferResponseType<
	typeof issue.activity.$get,
	200
>["activity"][number];
export type TurretIssueRecovery = NonNullable<
	InferResponseType<typeof issue.recovery.$get, 200>["recovery"]
>;
export type TurretAssignee = InferResponseType<
	typeof turret.assignees.$get,
	200
>["assignees"][number];
export type TurretRequestSpan = InferResponseType<
	typeof replaySession.spans.$get,
	200
>["spansByBreadcrumbId"][string][number];

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

const turretIssueOccurrenceQueryOptions = (
	fingerprint: string,
	errorId: string
) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "event", errorId],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.event[":errorId"].$get(
					{
						param: {
							fingerprint: encodeURIComponent(fingerprint),
							errorId: encodeURIComponent(errorId),
						},
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretIssueReportsQueryOptions = (fingerprint: string) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "reports"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.reports.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretOutcomesQueryOptions = (
	input: InferRequestType<typeof turret.outcomes.$get>["query"]
) =>
	queryOptions({
		queryKey: ["turret", "outcomes", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret.outcomes.$get(
					{ query: input },
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretWorkflowAttemptsQueryOptions = (
	workflow: InferRequestType<
		(typeof turret.outcomes)[":workflow"]["attempts"]["$get"]
	>["param"]["workflow"],
	input: InferRequestType<
		(typeof turret.outcomes)[":workflow"]["attempts"]["$get"]
	>["query"]
) =>
	queryOptions({
		queryKey: ["turret", "outcomes", workflow, "attempts", input],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await turret.outcomes[":workflow"].attempts.$get(
					{ param: { workflow }, query: input },
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretAssigneesQueryOptions = queryOptions({
	queryKey: ["turret", "assignees"],
	queryFn: async ({ signal }) =>
		jsonOrThrow(await turret.assignees.$get({}, { init: { signal } })),
	retry: false,
	staleTime: 5 * 60_000,
});

const turretIssueActivityQueryOptions = (fingerprint: string) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "activity"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.activity.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

const turretIssueRecoveryQueryOptions = (fingerprint: string) =>
	queryOptions({
		queryKey: [...turretKeys.issue(fingerprint), "recovery"],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await issue.recovery.$get(
					{
						param: { fingerprint: encodeURIComponent(fingerprint) },
					},
					{ init: { signal } }
				)
			),
		retry: false,
	});

// Notes and links change the issue's activity and detail.
function turretIssueTrackingMutation(
	queryClient: QueryClient,
	fingerprint: string
) {
	const param = { fingerprint: encodeURIComponent(fingerprint) };
	return mutationOptions({
		mutationFn: async (
			input:
				| { action: "note"; body: string }
				| { action: "addLink"; url: string }
				| { action: "removeLink"; linkId: string }
		) => {
			switch (input.action) {
				case "note":
					return jsonOrThrow(
						await issue.notes.$post({
							param,
							json: { body: input.body },
						})
					);
				case "addLink":
					return jsonOrThrow(
						await issue.links.$post({
							param,
							json: { url: input.url },
						})
					);
				case "removeLink":
					return jsonOrThrow(
						await issue.links[":linkId"].$delete({
							param: {
								...param,
								linkId: encodeURIComponent(input.linkId),
							},
						})
					);
			}
		},
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: turretKeys.issue(fingerprint),
			}),
	});
}

// Fetched on demand: an export is a snapshot, not a view to keep fresh.
async function fetchInvestigationExport(
	fingerprint: string,
	focus: { event?: string; report?: string }
) {
	return jsonOrThrow(
		await issue.export.$get({
			param: { fingerprint: encodeURIComponent(fingerprint) },
			query: focus,
		})
	);
}

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

// Linking changes a report, the issue it leaves, and the issue it joins, so
// every issue and feedback reader refreshes.
async function invalidateFeedbackLinks(queryClient: QueryClient) {
	await Promise.all([
		queryClient.invalidateQueries({ queryKey: turretKeys.feedback }),
		queryClient.invalidateQueries({ queryKey: turretKeys.issues }),
		queryClient.invalidateQueries({ queryKey: ["turret", "issue"] }),
		queryClient.invalidateQueries({ queryKey: turretKeys.sessions }),
	]);
}

const feedbackIssue = turret.feedback[":id"].issue;

function turretFeedbackIssueMutation(queryClient: QueryClient) {
	return mutationOptions({
		mutationFn: async (
			input:
				| { action: "promote"; feedbackId: string }
				| {
						action: "link";
						feedbackId: string;
						issueFingerprint: string;
				  }
				| { action: "unlink"; feedbackId: string }
		) => {
			const param = { id: encodeURIComponent(input.feedbackId) };
			switch (input.action) {
				case "promote":
					return jsonOrThrow(await feedbackIssue.$post({ param }));
				case "link":
					return jsonOrThrow(
						await feedbackIssue.$put({
							param,
							json: { issueFingerprint: input.issueFingerprint },
						})
					);
				case "unlink":
					await jsonOrThrow(await feedbackIssue.$delete({ param }));
					return { issueFingerprint: null };
			}
		},
		onSuccess: () => invalidateFeedbackLinks(queryClient),
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
	turretIssueOccurrenceQueryOptions,
	turretIssueReportsQueryOptions,
	fetchInvestigationExport,
	turretAssigneesQueryOptions,
	turretOutcomesQueryOptions,
	turretWorkflowAttemptsQueryOptions,
	turretIssueActivityQueryOptions,
	turretIssueRecoveryQueryOptions,
	turretIssueTrackingMutation,
	turretFeedbackIssueMutation,
	turretFeedbackQueryOptions,
	turretReplaySessionFeedbackQueryOptions,
	turretFeedbackStatusMutation,
};
