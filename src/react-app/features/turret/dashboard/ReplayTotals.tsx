import type { SummaryQuery } from "./summaryQuery";

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

import type { TurretSummary } from "../queries";
import { formatSummaryWindow } from "./summaryFormat";

type ReplayTotals = Extract<
	TurretSummary["replay"],
	{ state: "ready" }
>["totals"];

type ReplayTotalsStatus =
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "unavailable" }
	| { kind: "ready"; totals: ReplayTotals };

// Prefer the last good response over a failed background refetch.
function replayTotalsStatus(query: SummaryQuery): ReplayTotalsStatus {
	const data = query.data;
	if (data) {
		return data.replay.state === "ready"
			? { kind: "ready", totals: data.replay.totals }
			: { kind: "unavailable" };
	}
	return query.isError ? { kind: "error" } : { kind: "loading" };
}

function ReplayTotalValue(props: {
	query: SummaryQuery;
	field: keyof ReplayTotals;
}) {
	const status = replayTotalsStatus(props.query);
	if (status.kind === "loading") {
		return (
			<>
				<span aria-hidden="true">…</span>
				<span className="sr-only">Loading</span>
			</>
		);
	}
	if (status.kind !== "ready") {
		return (
			<span className="font-normal text-muted-foreground">
				Unavailable
			</span>
		);
	}
	return <>{status.totals[props.field].toLocaleString()}</>;
}

function LastHourReplayCard(props: { query: SummaryQuery }) {
	const status = replayTotalsStatus(props.query);
	const data = props.query.data;
	const rows: Array<{ field: keyof ReplayTotals; label: string }> = [
		{ field: "replaySessions", label: "Replay sessions" },
		{ field: "errorReplaySessions", label: "Error replay sessions" },
		{ field: "captureBlocked", label: "Capture blocked" },
	];

	return (
		<Card>
			<CardHeader>
				<CardTitle>Last hour</CardTitle>
				<CardDescription>
					{data
						? `All replay sessions, ${formatSummaryWindow(data)}`
						: "All replay sessions"}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-1 text-sm">
				{rows.map((row) => (
					<div
						key={row.field}
						className="flex items-center justify-between gap-3"
					>
						<div className="text-muted-foreground">{row.label}</div>
						<div className="font-medium tabular-nums">
							<ReplayTotalValue
								query={props.query}
								field={row.field}
							/>
						</div>
					</div>
				))}
				{status.kind === "error" ? (
					<p className="pt-2 text-xs text-muted-foreground">
						Couldn't load replay totals.
					</p>
				) : status.kind === "unavailable" ? (
					<p className="pt-2 text-xs text-muted-foreground">
						Replay totals are unavailable right now.
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}

export { LastHourReplayCard, ReplayTotalValue };
