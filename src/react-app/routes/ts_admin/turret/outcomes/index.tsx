import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { turretListPageDefaults } from "@/contracts/turret-pagination";
import {
	turretOutcomeStatusSchema,
	turretWorkflowLabels,
	type TurretOutcomeStatus,
} from "@/contracts/turret-outcomes";

import { REPLAY_LEAD_MS } from "../../../../features/turret/investigation/timeline";
import {
	outcomePresetSchema,
	outcomeStatusLabels,
	outcomesSearchSchema,
	successRate,
} from "../../../../features/turret/outcomeSearch";
import {
	turretOutcomesQueryOptions,
	turretWorkflowAttemptsQueryOptions,
} from "../../../../features/turret/queries";
import { presetToRange } from "../../../../features/turret/timeRange";

const Route = createFileRoute("/ts_admin/turret/outcomes/")({
	validateSearch: outcomesSearchSchema,
	component: TurretOutcomesPage,
});

function formatRate(rate: number | null) {
	return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

// The moment worth watching: the last failure, the success, or where the
// user went quiet.
function attemptMoment(attempt: {
	status: TurretOutcomeStatus;
	lastFailureAt: number | null;
	succeededAt: number | null;
	lastEventAt: number;
}) {
	if (attempt.status === "succeeded" && attempt.succeededAt !== null)
		return attempt.succeededAt;
	return attempt.lastFailureAt ?? attempt.lastEventAt;
}

function TurretOutcomesPage() {
	const navigate = useNavigate();
	const search: z.output<typeof outcomesSearchSchema> = Route.useSearch();
	const [now] = useState(() => Date.now());
	const range = useMemo(
		() => presetToRange(search.preset, now),
		[search.preset, now]
	);
	const summaryQuery = useQuery(turretOutcomesQueryOptions(range));
	const attemptsQuery = useQuery(
		turretWorkflowAttemptsQueryOptions(search.workflow, {
			...range,
			status: search.status,
			limit: turretListPageDefaults.limit,
			offset: search.offset,
		})
	);

	function update(next: Partial<typeof search>) {
		navigate({
			to: "/ts_admin/turret/outcomes",
			search: { ...search, offset: 0, ...next },
		});
	}

	const idleMinutes = (summaryQuery.data?.idleMs ?? 0) / 60_000;
	const attempts = attemptsQuery.data?.attempts ?? [];

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						Outcomes
					</h1>
					<p className="text-sm text-muted-foreground">
						Whether people complete key workflows, including
						failures that never raise an error. An attempt that
						doesn't succeed counts as failed or abandoned after{" "}
						{idleMinutes} minutes without activity.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{outcomePresetSchema.options.map((preset) => (
						<Button
							key={preset}
							type="button"
							variant={
								search.preset === preset ? "default" : "outline"
							}
							onClick={() => update({ preset })}
						>
							{`Last ${preset}`}
						</Button>
					))}
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Workflows</CardTitle>
				</CardHeader>
				<CardContent>
					{summaryQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : summaryQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load outcomes.
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Workflow</TableHead>
									<TableHead className="text-right">
										Attempts
									</TableHead>
									<TableHead className="text-right">
										Success rate
									</TableHead>
									<TableHead className="text-right">
										Succeeded
									</TableHead>
									<TableHead className="text-right">
										Failed
									</TableHead>
									<TableHead className="text-right">
										Abandoned
									</TableHead>
									<TableHead className="text-right">
										In progress
									</TableHead>
									<TableHead>Top failure reasons</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(summaryQuery.data?.workflows ?? []).map(
									(w) => (
										<TableRow
											key={w.workflow}
											data-state={
												w.workflow === search.workflow
													? "selected"
													: undefined
											}
											className="cursor-pointer"
											onClick={() =>
												update({ workflow: w.workflow })
											}
										>
											<TableCell className="font-medium">
												{
													turretWorkflowLabels[
														w.workflow
													]
												}
												<div className="font-mono text-xs text-muted-foreground">
													{w.workflow}
												</div>
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{w.attempts.toLocaleString()}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{formatRate(successRate(w))}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{w.succeeded.toLocaleString()}
												{w.succeededAfterFailure > 0 ? (
													<div className="text-xs text-muted-foreground">
														{w.succeededAfterFailure.toLocaleString()}{" "}
														after a failure
													</div>
												) : null}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{w.failed.toLocaleString()}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{w.abandoned.toLocaleString()}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{w.inProgress.toLocaleString()}
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													{w.reasons.length === 0 ? (
														<span className="text-xs text-muted-foreground">
															—
														</span>
													) : (
														w.reasons.map((r) => (
															<Badge
																key={r.reason}
																variant="outline"
															>
																{r.reason} ·{" "}
																{r.attempts}
															</Badge>
														))
													)}
												</div>
											</TableCell>
										</TableRow>
									)
								)}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<CardTitle>
							{turretWorkflowLabels[search.workflow]} attempts
						</CardTitle>
						<div className="flex flex-wrap gap-2">
							{turretOutcomeStatusSchema.options.map((status) => (
								<Button
									key={status}
									type="button"
									size="sm"
									variant={
										search.status === status
											? "default"
											: "outline"
									}
									onClick={() => update({ status })}
								>
									{outcomeStatusLabels[status]}
								</Button>
							))}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{attemptsQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : attemptsQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load attempts.
						</div>
					) : attempts.length === 0 ? (
						<div className="text-sm text-muted-foreground">
							No{" "}
							{outcomeStatusLabels[search.status].toLowerCase()}{" "}
							attempts in this range.
						</div>
					) : (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Started</TableHead>
										<TableHead>User</TableHead>
										<TableHead>Failures</TableHead>
										<TableHead>Last activity</TableHead>
										<TableHead>
											<span className="sr-only">
												Replay
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{attempts.map((a) => (
										<TableRow key={a.id}>
											<TableCell className="whitespace-nowrap">
												{new Date(
													a.startedAt
												).toLocaleString()}
											</TableCell>
											<TableCell className="max-w-[220px] truncate text-sm">
												{a.userEmail ?? a.userId}
											</TableCell>
											<TableCell>
												{a.failures === 0 ? (
													<span className="text-muted-foreground">
														0
													</span>
												) : (
													<span>
														{a.failures}{" "}
														<span className="font-mono text-xs text-muted-foreground">
															last:{" "}
															{
																a.lastFailureReason
															}
														</span>
													</span>
												)}
											</TableCell>
											<TableCell className="whitespace-nowrap">
												{new Date(
													a.lastEventAt
												).toLocaleString()}
											</TableCell>
											<TableCell className="text-right">
												{a.replayAvailable ? (
													<Link
														to="/ts_admin/turret/replay-sessions/$sessionId"
														params={{
															sessionId:
																a.sessionId,
														}}
														search={{
															t: Math.max(
																0,
																attemptMoment(
																	a
																) -
																	REPLAY_LEAD_MS
															),
														}}
														className="text-sm underline underline-offset-4"
													>
														Watch replay
													</Link>
												) : (
													<span className="text-xs text-muted-foreground">
														No replay
													</span>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							<div className="mt-4 flex items-center justify-between gap-3">
								<Button
									type="button"
									variant="outline"
									disabled={search.offset <= 0}
									onClick={() =>
										update({
											offset: Math.max(
												0,
												search.offset -
													turretListPageDefaults.limit
											),
										})
									}
								>
									Prev
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={
										attempts.length <
										turretListPageDefaults.limit
									}
									onClick={() =>
										update({
											offset:
												search.offset +
												turretListPageDefaults.limit,
										})
									}
								>
									Next
								</Button>
							</div>
						</>
					)}
				</CardContent>
			</Card>
		</section>
	);
}

export { Route };
