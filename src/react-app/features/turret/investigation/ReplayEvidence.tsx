import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type RefObject } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	turretBreadcrumbPageDefaults,
	turretListPageDefaults,
	turretSpanPageDefaults,
} from "@/contracts/turret-pagination";

import {
	turretFeedbackIssueMutation,
	turretReplaySessionBreadcrumbsQueryOptions,
	turretReplaySessionErrorsQueryOptions,
	turretReplaySessionFeedbackQueryOptions,
	turretReplaySessionSpansQueryOptions,
} from "../queries";
import type {
	ReplayConsoleItem,
	useReplayPlayer,
} from "../session/useReplayPlayer";
import { InvestigationTimeline } from "./InvestigationTimeline";
import {
	NEARBY_AFTER_MS,
	NEARBY_BEFORE_MS,
	REPLAY_LEAD_MS,
	buildInvestigationTimeline,
	nearbyWindow,
	type InvestigationFocus,
} from "./timeline";

type TimelineScope = "nearby" | "session";

// The embedded player for a replay session, with a link to the full replay
// session page at the current start position.
export function ReplayCard({
	sessionId,
	startTs,
	focusLabel,
	playerHostRef,
	status,
	ready,
}: {
	sessionId: string;
	startTs: number;
	focusLabel: string;
	playerHostRef: RefObject<HTMLDivElement | null>;
	status: ReturnType<typeof useReplayPlayer>["status"];
	ready: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<CardTitle>Replay</CardTitle>
					<Link
						to="/ts_admin/turret/replay-sessions/$sessionId"
						params={{ sessionId: sessionId }}
						search={{ t: startTs }}
						className={buttonVariants({
							variant: "outline",
							size: "sm",
						})}
					>
						Open replay session
					</Link>
				</div>
			</CardHeader>
			<CardContent>
				<div className="text-xs text-muted-foreground">
					{status.state === "loading"
						? `Loading replay… ${status.loaded}/${status.total}`
						: status.state === "error"
							? `Failed to load replay: ${status.message}`
							: ready
								? `Positioned ${REPLAY_LEAD_MS / 1000}s before the ${focusLabel}. Use Jump in the timeline to move to other evidence.`
								: null}
				</div>
				<div
					ref={playerHostRef}
					className="mt-2 min-h-[420px] overflow-hidden rounded-md border bg-background"
				/>
			</CardContent>
		</Card>
	);
}

// Merges the replay session's requests, console output, errors, and reports
// around the focused evidence. Reports here can be linked to the issue.
export function SessionTimeline(props: {
	sessionId: string;
	focus: InvestigationFocus;
	fingerprint: string;
	matchedRequestId: string | null;
	consoleItems: ReplayConsoleItem[];
	replay: { ready: boolean; onJump: (ts: number) => void };
}) {
	const queryClient = useQueryClient();
	const linkMutation = useMutation(turretFeedbackIssueMutation(queryClient));
	const [scope, setScope] = useState<TimelineScope>("nearby");
	const window = useMemo(
		() => (scope === "nearby" ? nearbyWindow(props.focus.ts) : null),
		[scope, props.focus.ts]
	);
	const errorsQuery = useQuery(
		turretReplaySessionErrorsQueryOptions(props.sessionId)
	);
	const feedbackQuery = useQuery(
		turretReplaySessionFeedbackQueryOptions(props.sessionId, {
			limit: turretListPageDefaults.limit,
			offset: 0,
		})
	);
	const breadcrumbsQuery = useQuery(
		turretReplaySessionBreadcrumbsQueryOptions(props.sessionId, {
			limit: turretBreadcrumbPageDefaults.limit,
			offset: 0,
			...window,
		})
	);
	const spansQuery = useQuery(
		turretReplaySessionSpansQueryOptions(props.sessionId, {
			limit: turretSpanPageDefaults.limit,
			offset: 0,
		})
	);

	const entries = useMemo(
		() =>
			buildInvestigationTimeline({
				errors: errorsQuery.data?.errors ?? [],
				feedback: feedbackQuery.data?.feedback ?? [],
				requests: breadcrumbsQuery.data?.breadcrumbs ?? [],
				console: props.consoleItems,
				window,
			}),
		[
			errorsQuery.data,
			feedbackQuery.data,
			breadcrumbsQuery.data,
			props.consoleItems,
			window,
		]
	);

	const loading =
		errorsQuery.isLoading ||
		feedbackQuery.isLoading ||
		breadcrumbsQuery.isLoading;
	const failed = [
		errorsQuery.isError && "errors",
		feedbackQuery.isError && "feedback",
		breadcrumbsQuery.isError && "requests",
		spansQuery.isError && "D1 spans",
	].filter(Boolean);
	const requestsTruncated =
		(breadcrumbsQuery.data?.breadcrumbs.length ?? 0) >=
		turretBreadcrumbPageDefaults.limit;

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="space-y-1">
						<CardTitle>Timeline</CardTitle>
						<p className="text-xs text-muted-foreground">
							Requests, console output, errors, and feedback from
							this replay session, relative to the{" "}
							{props.focus.kind === "error"
								? "occurrence"
								: "report"}
							.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							size="sm"
							variant={scope === "nearby" ? "default" : "outline"}
							onClick={() => setScope("nearby")}
						>
							{`${NEARBY_BEFORE_MS / 60_000}m before – ${NEARBY_AFTER_MS / 1000}s after`}
						</Button>
						<Button
							type="button"
							size="sm"
							variant={
								scope === "session" ? "default" : "outline"
							}
							onClick={() => setScope("session")}
						>
							Whole replay session
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				{linkMutation.isError ? (
					<div className="text-sm text-destructive">
						Couldn't link the report: {linkMutation.error.message}
					</div>
				) : null}
				{failed.length > 0 ? (
					<div className="text-sm text-destructive">
						Failed to load {failed.join(", ")}. The timeline is
						incomplete.
					</div>
				) : null}
				{!props.replay.ready ? (
					<div className="text-xs text-muted-foreground">
						Console output appears once the replay loads.
					</div>
				) : null}
				{requestsTruncated || spansQuery.data?.hasMore ? (
					<div className="text-xs text-muted-foreground">
						{requestsTruncated
							? `Showing the first ${turretBreadcrumbPageDefaults.limit} requests in this range. `
							: ""}
						{spansQuery.data?.hasMore
							? "Some D1 spans are not shown."
							: ""}
					</div>
				) : null}
				{loading ? (
					<div className="text-sm text-muted-foreground">
						Loading timeline…
					</div>
				) : entries.length === 0 ? (
					<div className="text-sm text-muted-foreground">
						Nothing recorded in this range.
					</div>
				) : (
					<InvestigationTimeline
						entries={entries}
						focus={props.focus}
						fingerprint={props.fingerprint}
						matchedRequestId={props.matchedRequestId}
						spansByBreadcrumbId={
							spansQuery.data?.spansByBreadcrumbId ?? {}
						}
						replay={props.replay}
						linkReport={{
							pending: linkMutation.isPending,
							onLink: (feedbackId) =>
								linkMutation.mutate({
									action: "link",
									feedbackId,
									issueFingerprint: props.fingerprint,
								}),
						}}
					/>
				)}
			</CardContent>
		</Card>
	);
}
