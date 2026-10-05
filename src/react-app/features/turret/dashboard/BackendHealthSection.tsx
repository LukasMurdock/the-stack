import type { SummaryQuery } from "./summaryQuery";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

import type { TurretSummary } from "../../../lib/turretApi";
import {
	abbreviateVersion,
	formatCount,
	formatDuration,
	formatRate,
	formatSummaryWindow,
	formatTime,
} from "./summaryFormat";

type ReadyOperations = Extract<TurretSummary["operations"], { state: "ready" }>;
type UnavailableReason = Extract<
	TurretSummary["operations"],
	{ state: "unavailable" }
>["reason"];

const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
	not_configured:
		"Operational metrics aren't configured for this environment.",
	local_environment: "Backend health queries are available after deployment.",
	query_failed:
		"The operational metrics query failed. It will retry on the next refresh.",
};

function BackendHealthSection(props: { query: SummaryQuery }) {
	const { query } = props;
	const data = query.data;

	return (
		<section aria-labelledby="backend-health-heading" className="space-y-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<h2
							id="backend-health-heading"
							className="text-lg font-semibold tracking-tight"
						>
							Backend health
						</h2>
						<Badge variant="outline">Sampled estimates</Badge>
					</div>
					<p className="text-sm text-muted-foreground">
						Last hour
						{data ? ` (${formatSummaryWindow(data)})` : ""}. Request
						counts are estimated from sampled telemetry and exclude
						admin and health-check traffic. The most recent minutes
						may still be arriving.
					</p>
				</div>
				{data ? (
					<p className="text-xs text-muted-foreground">
						Updated {formatTime(query.dataUpdatedAt)} · refreshes
						every minute
					</p>
				) : null}
			</div>

			{data && query.isRefetchError ? (
				<p role="status" className="text-xs text-destructive">
					Latest refresh failed; showing data from{" "}
					{formatTime(query.dataUpdatedAt)}.
				</p>
			) : null}

			{!data ? (
				query.isError ? (
					<StatusCard>
						<span>Couldn't load backend health.</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							Retry
						</Button>
					</StatusCard>
				) : (
					<StatusCard>Loading backend health…</StatusCard>
				)
			) : data.operations.state === "unavailable" ? (
				<StatusCard>
					<span>
						<span className="font-medium text-foreground">
							Unavailable.
						</span>{" "}
						{UNAVAILABLE_MESSAGES[data.operations.reason]}
					</span>
				</StatusCard>
			) : (
				<OperationsReady operations={data.operations} />
			)}
		</section>
	);
}

function StatusCard(props: { children: ReactNode }) {
	return (
		<Card size="sm">
			<CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
				{props.children}
			</CardContent>
		</Card>
	);
}

function StatCard(props: { label: string; value: string; detail: string }) {
	return (
		<Card size="sm">
			<CardContent className="space-y-1">
				<div className="text-xs text-muted-foreground">
					{props.label}
				</div>
				<div className="text-2xl font-semibold tabular-nums">
					{props.value}
				</div>
				<div className="text-xs text-muted-foreground">
					{props.detail}
				</div>
			</CardContent>
		</Card>
	);
}

function OperationsReady(props: { operations: ReadyOperations }) {
	const { totals, routes } = props.operations;

	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatCard
					label="Requests"
					value={formatCount(totals.requests)}
					detail="Estimated, last hour"
				/>
				<StatCard
					label="Server errors (5xx)"
					value={formatCount(totals.serverErrors)}
					detail={`${formatRate(totals.serverErrors, totals.requests)} of requests`}
				/>
				<StatCard
					label="Slow requests"
					value={formatCount(totals.slowRequests)}
					detail={`${formatRate(totals.slowRequests, totals.requests)} of requests`}
				/>
				<StatCard
					label="Latency (p95)"
					value={formatDuration(totals.p95DurationMs)}
					detail={`Average ${formatDuration(totals.avgDurationMs)}`}
				/>
			</div>

			<Card size="sm">
				<CardHeader>
					<CardTitle>Top routes</CardTitle>
					<CardDescription>
						Up to 10 routes in the last hour, with sampled estimates
						per deployment version.
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					{routes.length === 0 ? (
						<div className="px-4 py-3 text-sm text-muted-foreground">
							No requests recorded in this window.
						</div>
					) : (
						<Table>
							<TableCaption className="sr-only">
								Top routes in the last hour with estimated
								request volume, server error rate, latency, and
								deployment version.
							</TableCaption>
							<TableHeader>
								<TableRow>
									<TableHead className="px-4">
										Route
									</TableHead>
									<TableHead className="text-right">
										Requests
									</TableHead>
									<TableHead className="text-right">
										5xx
									</TableHead>
									<TableHead className="text-right">
										Avg
									</TableHead>
									<TableHead className="text-right">
										p95
									</TableHead>
									<TableHead className="px-4">
										Version
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{routes.map((r) => (
									<TableRow
										key={`${r.surface}|${r.method}|${r.route}|${r.category}|${r.version}`}
									>
										<TableCell className="max-w-[320px] px-4">
											<div className="truncate font-medium">
												<span className="font-mono text-xs">
													{r.method}
												</span>{" "}
												<span title={r.route}>
													{r.route}
												</span>
											</div>
											<div className="truncate text-xs text-muted-foreground">
												{r.surface} · {r.category}
											</div>
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatCount(r.requests)}
										</TableCell>
										<TableCell
											className={
												"text-right tabular-nums " +
												(r.serverErrors > 0
													? "text-destructive"
													: "")
											}
										>
											{formatCount(r.serverErrors)}
											<span className="text-xs text-muted-foreground">
												{` (${formatRate(r.serverErrors, r.requests)})`}
											</span>
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatDuration(r.avgDurationMs)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatDuration(r.p95DurationMs)}
										</TableCell>
										<TableCell className="px-4">
											<span
												className="font-mono text-xs"
												title={r.version || undefined}
											>
												{abbreviateVersion(r.version)}
											</span>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

export { BackendHealthSection };
