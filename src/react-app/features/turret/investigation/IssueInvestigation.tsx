import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useId } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { CLOUDFLARE_TRACES_URL, TRACE_LINK_HINT } from "../cloudflareTraces";
import { CopyButton } from "../CopyButton";
import {
	turretIssueOccurrenceQueryOptions,
	type TurretIssueOccurrence,
} from "../queries";
import { RequestBreadcrumbRow } from "../session/RequestBreadcrumbRow";
import { useReplayPlayer } from "../session/useReplayPlayer";
import { ReplayCard, SessionTimeline } from "./ReplayEvidence";
import { REPLAY_LEAD_MS } from "./timeline";

// Opens one occurrence of an issue with everything recorded around it: replay
// positioned just before the failure, request correlation, and a merged
// timeline of the replay session's evidence.
export function IssueInvestigation(props: {
	fingerprint: string;
	errorId: string;
	isRepresentative: boolean;
	// Replay position from the URL; defaults to just before the occurrence.
	position: number | undefined;
	onSelectOccurrence: (errorId: string) => void;
	onPositionChange: (ts: number) => void;
}) {
	// Keep the previous occurrence while stepping so a replay of the same
	// session stays mounted and only repositions.
	const occurrenceQuery = useQuery({
		...turretIssueOccurrenceQueryOptions(props.fingerprint, props.errorId),
		placeholderData: keepPreviousData,
	});
	const data = occurrenceQuery.data;
	const occurrence = data?.occurrence;
	const replaySessionId =
		occurrence?.replayAvailable && occurrence.sessionId
			? occurrence.sessionId
			: null;
	const startTs = occurrence
		? (props.position ?? occurrence.ts - REPLAY_LEAD_MS)
		: null;
	const {
		playerHostRef,
		status: replayStatus,
		ready: replayReady,
		consoleItems,
		seek,
	} = useReplayPlayer(replaySessionId, {
		startAt:
			occurrence && startTs !== null
				? { key: occurrence.id, ts: startTs }
				: undefined,
	});

	function jump(ts: number) {
		seek(ts);
		props.onPositionChange(ts);
	}

	if (occurrenceQuery.isLoading)
		return (
			<Card>
				<CardContent className="text-sm text-muted-foreground">
					Loading occurrence…
				</CardContent>
			</Card>
		);
	if (occurrenceQuery.isError || !data || !occurrence)
		return (
			<Card>
				<CardContent className="text-sm text-destructive">
					Failed to load this occurrence. It may have expired under
					retention.
				</CardContent>
			</Card>
		);

	return (
		<>
			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="space-y-1">
							<CardTitle>
								{props.isRepresentative
									? "Representative occurrence"
									: "Selected occurrence"}
							</CardTitle>
							<p className="text-xs text-muted-foreground">
								{props.isRepresentative
									? occurrence.replayAvailable
										? "The most recent occurrence with a replay."
										: "The most recent occurrence. No occurrence has a playable replay."
									: "Chosen from the occurrences below."}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!occurrence.newerId}
								onClick={() =>
									occurrence.newerId &&
									props.onSelectOccurrence(occurrence.newerId)
								}
							>
								Newer
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!occurrence.olderId}
								onClick={() =>
									occurrence.olderId &&
									props.onSelectOccurrence(occurrence.olderId)
								}
							>
								Older
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1">
						<div className="text-base font-medium break-words">
							{occurrence.message ?? "(no message)"}
						</div>
						<div className="text-xs text-muted-foreground">
							{occurrence.source} ·{" "}
							{new Date(occurrence.ts).toLocaleString()}
						</div>
					</div>

					<OccurrenceCorrelation occurrence={occurrence} />

					{occurrence.stack ? (
						<details open className="text-xs">
							<summary className="cursor-pointer select-none text-muted-foreground">
								Stack
							</summary>
							<pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-snug">
								{occurrence.stack}
							</pre>
						</details>
					) : null}

					{data.request ? (
						<div className="space-y-2">
							<div className="text-sm font-medium">
								Request that failed
							</div>
							<RequestBreadcrumbRow
								breadcrumb={data.request}
								ts={new Date(data.request.ts).getTime()}
								spans={data.requestSpans}
								replay={
									replaySessionId
										? {
												ready: replayReady,
												onJump: jump,
											}
										: undefined
								}
							/>
						</div>
					) : null}
				</CardContent>
			</Card>

			{replaySessionId && startTs !== null ? (
				<>
					<ReplayCard
						sessionId={replaySessionId}
						startTs={startTs}
						focusLabel="occurrence"
						playerHostRef={playerHostRef}
						status={replayStatus}
						ready={replayReady}
					/>
					<SessionTimeline
						sessionId={replaySessionId}
						focus={{
							kind: "error",
							id: occurrence.id,
							ts: occurrence.ts,
						}}
						fingerprint={props.fingerprint}
						matchedRequestId={data.request?.id ?? null}
						consoleItems={consoleItems}
						replay={{ ready: replayReady, onJump: jump }}
					/>
				</>
			) : (
				<Card>
					<CardContent className="text-sm text-muted-foreground">
						{occurrence.sessionId
							? "This occurrence's replay session has no playable replay or has expired."
							: "This occurrence was captured outside a replay session, so the failing request is the available context."}
					</CardContent>
				</Card>
			)}
		</>
	);
}

function OccurrenceCorrelation(props: {
	occurrence: TurretIssueOccurrence["occurrence"];
}) {
	const { correlation } = props.occurrence;
	const traceHintId = useId();
	const rows = [
		["Request ID", correlation.requestId],
		["Ray ID", correlation.rayId],
		["Deployment", correlation.workerVersion],
		[
			"Route",
			correlation.route
				? [correlation.method, correlation.route]
						.filter(Boolean)
						.join(" ")
				: null,
		],
		[
			"Status",
			correlation.status != null ? String(correlation.status) : null,
		],
		["Replay session", props.occurrence.sessionId],
	] as const;
	const present = rows.filter(([, value]) => value);
	if (present.length === 0) return null;
	return (
		<div className="flex flex-wrap items-start justify-between gap-3">
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
				{present.map(([label, value]) => (
					<div key={label} className="contents">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="truncate font-mono select-all">
							{value}
						</dd>
					</div>
				))}
			</dl>
			{correlation.requestId || correlation.rayId ? (
				<div className="flex flex-wrap items-center gap-2">
					{correlation.requestId ? (
						<CopyButton
							value={correlation.requestId}
							label="Copy request ID"
							noun="Request ID"
						/>
					) : null}
					{correlation.rayId ? (
						<CopyButton
							value={correlation.rayId}
							label="Copy Ray ID"
							noun="Ray ID"
						/>
					) : null}
					<a
						href={CLOUDFLARE_TRACES_URL}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({
							variant: "outline",
							size: "xs",
						})}
						title={TRACE_LINK_HINT}
						aria-describedby={traceHintId}
					>
						Search Cloudflare traces
						<ExternalLink aria-hidden="true" />
					</a>
					<span id={traceHintId} className="sr-only">
						{TRACE_LINK_HINT}
					</span>
				</div>
			) : null}
		</div>
	);
}
