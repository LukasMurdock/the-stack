import { Link } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
	TurretReplaySessionError,
	TurretReplaySessionFeedback,
	TurretRequestBreadcrumb,
	TurretRequestSpan,
} from "../queries";
import { RequestBreadcrumbRow } from "../session/RequestBreadcrumbRow";
import { formatConsolePayload } from "../session/useReplayPlayer";
import {
	formatOffset,
	type InvestigationFocus,
	type TimelineEntry,
} from "./timeline";

type Entry = TimelineEntry<
	TurretReplaySessionError,
	TurretReplaySessionFeedback,
	TurretRequestBreadcrumb
>;

const kindLabels = {
	request: "Request",
	console: "Console",
	error: "Error",
	feedback: "Feedback",
} satisfies Record<Entry["kind"], string>;

type LinkReport = {
	pending: boolean;
	onLink: (feedbackId: string) => void;
};

export function InvestigationTimeline(props: {
	entries: Entry[];
	focus: InvestigationFocus;
	fingerprint: string;
	matchedRequestId: string | null;
	spansByBreadcrumbId: Record<string, TurretRequestSpan[]>;
	replay: { ready: boolean; onJump: (ts: number) => void };
	linkReport: LinkReport;
}) {
	const { focus, replay } = props;
	return (
		<ol className="space-y-2">
			{props.entries.map((entry) => {
				const highlighted =
					(entry.kind === focus.kind &&
						entry.value.id === focus.id) ||
					(entry.kind === "request" &&
						entry.value.id === props.matchedRequestId);
				return (
					<li
						key={entry.key}
						className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3"
					>
						<div
							className="pt-3 text-right font-mono text-xs text-muted-foreground tabular-nums"
							title={new Date(entry.ts).toLocaleString()}
						>
							{formatOffset(entry.ts - focus.ts)}
						</div>
						<div
							className={cn(
								"min-w-0 rounded-md",
								highlighted &&
									"ring-2 ring-destructive/60 ring-offset-2 ring-offset-background"
							)}
						>
							{entry.kind === "request" ? (
								<RequestBreadcrumbRow
									breadcrumb={entry.value}
									ts={entry.ts}
									spans={
										props.spansByBreadcrumbId[
											entry.value.id
										] ?? []
									}
									replay={replay}
								/>
							) : (
								<div className="rounded-md border bg-card p-3">
									<div className="flex flex-wrap items-start justify-between gap-3">
										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<Badge variant="outline">
													{kindLabels[entry.kind]}
												</Badge>
												<TimelineEntryLabel
													entry={entry}
													focus={focus}
													fingerprint={
														props.fingerprint
													}
													linkReport={
														props.linkReport
													}
												/>
											</div>
											<TimelineEntryBody entry={entry} />
										</div>
										<Button
											type="button"
											variant="outline"
											size="xs"
											disabled={!replay.ready}
											onClick={() =>
												replay.onJump(entry.ts)
											}
										>
											Jump
										</Button>
									</div>
								</div>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

function IssueLink(props: { fingerprint: string; children: string }) {
	return (
		<Link
			to="/ts_admin/turret/issues/$fingerprint"
			params={{ fingerprint: props.fingerprint }}
			search={{}}
			className="text-xs underline underline-offset-4"
		>
			{props.children}
		</Link>
	);
}

function TimelineEntryLabel(props: {
	entry: Entry;
	focus: InvestigationFocus;
	fingerprint: string;
	linkReport: LinkReport;
}) {
	const { entry, focus, fingerprint } = props;
	if (entry.kind === "console")
		return (
			<span className="text-xs text-muted-foreground">
				{entry.value.level}
			</span>
		);
	if (entry.kind === "feedback") {
		const linkedTo = entry.value.issueFingerprint;
		return (
			<>
				<span className="text-xs text-muted-foreground">
					{entry.value.kind} · {entry.value.status}
				</span>
				{focus.kind === "feedback" && entry.value.id === focus.id ? (
					<Badge variant="destructive">This report</Badge>
				) : linkedTo === fingerprint ? (
					<span className="text-xs text-muted-foreground">
						Linked to this issue
					</span>
				) : (
					<>
						{linkedTo ? (
							<IssueLink fingerprint={linkedTo}>
								Linked to another issue
							</IssueLink>
						) : null}
						<Button
							type="button"
							variant="outline"
							size="xs"
							disabled={props.linkReport.pending}
							onClick={() =>
								props.linkReport.onLink(entry.value.id)
							}
						>
							{linkedTo
								? "Move to this issue"
								: "Link to this issue"}
						</Button>
					</>
				)}
			</>
		);
	}
	if (entry.kind !== "error") return null;
	if (focus.kind === "error" && entry.value.id === focus.id)
		return <Badge variant="destructive">This occurrence</Badge>;
	if (entry.value.fingerprint === fingerprint)
		return (
			<span className="text-xs text-muted-foreground">Same issue</span>
		);
	if (!entry.value.fingerprint) return null;
	return (
		<IssueLink fingerprint={entry.value.fingerprint}>
			Open its issue
		</IssueLink>
	);
}

function TimelineEntryBody(props: { entry: Entry }) {
	const { entry } = props;
	switch (entry.kind) {
		case "console":
			return (
				<>
					<div className="text-sm break-words">
						{formatConsolePayload(entry.value.payload)}
					</div>
					{entry.value.trace.length > 0 ? (
						<details className="text-xs">
							<summary className="cursor-pointer select-none text-muted-foreground">
								Trace
							</summary>
							<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug">
								{entry.value.trace.join("\n")}
							</pre>
						</details>
					) : null}
				</>
			);
		case "error":
			return (
				<>
					<div className="text-sm font-medium break-words">
						{entry.value.message ?? "(no message)"}
					</div>
					<div className="text-xs text-muted-foreground">
						{entry.value.source}
					</div>
					{entry.value.stack ? (
						<details className="text-xs">
							<summary className="cursor-pointer select-none text-muted-foreground">
								Stack
							</summary>
							<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-snug">
								{entry.value.stack}
							</pre>
						</details>
					) : null}
				</>
			);
		case "feedback":
			return (
				<>
					<div className="text-sm break-words">
						{entry.value.message}
					</div>
					{entry.value.url ? (
						<div
							className="truncate text-xs text-muted-foreground"
							title={entry.value.url}
						>
							{entry.value.url}
						</div>
					) : null}
				</>
			);
		case "request":
			return null;
	}
}
