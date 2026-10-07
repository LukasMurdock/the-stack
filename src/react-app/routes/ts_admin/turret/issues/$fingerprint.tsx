import {
	turretIssuePrioritySchema,
	type TurretIssuePriority,
} from "@/contracts/turret";
import {
	issueDetailSearchSchema,
	issuePresetSchema,
	issuePriorityLabels,
	bucketForIssuePreset,
	type IssueRangePreset as RangePreset,
} from "../../../../features/turret/issueSearch";
import {
	presetToRange,
	toLocalDatetimeValue,
	fromLocalDatetimeValue,
} from "../../../../features/turret/timeRange";

import { useDraftValue } from "@/react-app/hooks/useDraftValue";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ChartContainer } from "@/components/ui/chart";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Area, AreaChart, Tooltip, XAxis, YAxis } from "recharts";

import {
	turretIssueMutation,
	turretIssueEventsQueryOptions,
	turretIssueQueryOptions,
	turretIssueTrendQueryOptions,
	turretIssueReportsQueryOptions,
	turretFeedbackIssueMutation,
} from "../../../../features/turret/queries";
import type {
	TurretIssueReport,
	TurretIssueStatus,
} from "../../../../features/turret/queries";
import { IssueInvestigation } from "../../../../features/turret/investigation/IssueInvestigation";
import { ReportInvestigation } from "../../../../features/turret/investigation/ReportInvestigation";
import { ExportInvestigation } from "../../../../features/turret/investigation/ExportInvestigation";
import {
	IssueActivity,
	IssueLinks,
	IssueOwner,
	IssueRecovery,
} from "../../../../features/turret/investigation/IssueTracking";
import { REPLAY_LEAD_MS } from "../../../../features/turret/investigation/timeline";

const Route = createFileRoute("/ts_admin/turret/issues/$fingerprint")({
	validateSearch: issueDetailSearchSchema,
	component: TurretIssueDetailPage,
});

function TurretIssueDetailPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { fingerprint } = Route.useParams();
	const search = Route.useSearch();
	const [now] = useState(() => Date.now());

	const range = useMemo(() => {
		if (search.preset === "custom")
			return { from: search.from, to: search.to };
		return presetToRange(search.preset, now);
	}, [now, search.from, search.preset, search.to]);

	const issueQuery = useQuery(turretIssueQueryOptions(fingerprint));
	const reportsQuery = useQuery(turretIssueReportsQueryOptions(fingerprint));
	const linkMutation = useMutation(turretFeedbackIssueMutation(qc));
	const trendQuery = useQuery(
		turretIssueTrendQueryOptions(fingerprint, {
			from: range.from,
			to: range.to,
			bucket: search.bucket,
		})
	);
	const eventsQuery = useQuery(
		turretIssueEventsQueryOptions(fingerprint, {
			limit: search.eventsLimit,
			offset: search.eventsOffset,
		})
	);

	const issue = issueQuery.data?.issue;
	const currentDeploymentId = issueQuery.data?.currentDeploymentId ?? null;

	const {
		value: titleDraft,
		setValue: setTitleDraft,
		reset: resetTitleDraft,
	} = useDraftValue(issue?.title ?? issue?.sample.message ?? "", fingerprint);

	const updateMutation = useMutation(turretIssueMutation(qc, fingerprint));

	function setPreset(preset: RangePreset) {
		const next =
			preset === "custom"
				? { from: search.from, to: search.to }
				: presetToRange(preset, now);
		const nextBucket = bucketForIssuePreset(preset);
		navigate({
			to: "/ts_admin/turret/issues/$fingerprint",
			params: { fingerprint },
			search: {
				...search,
				preset,
				bucket: nextBucket,
				from: next.from,
				to: next.to,
			},
		});
	}

	function saveTitle() {
		const trimmed = titleDraft.trim();
		const next = trimmed ? trimmed : null;
		updateMutation.mutate(
			{ title: next },
			{ onSuccess: () => resetTitleDraft() }
		);
	}

	function setStatus(status: TurretIssueStatus) {
		updateMutation.mutate({ status });
	}

	function resolveInNextDeployment() {
		updateMutation.mutate({
			status: "resolved",
			resolveIn: "next_deployment",
		});
	}

	function setPriority(priority: TurretIssuePriority) {
		updateMutation.mutate({ priority });
	}

	function selectOccurrence(errorId: string) {
		navigate({
			to: "/ts_admin/turret/issues/$fingerprint",
			params: { fingerprint },
			search: {
				...search,
				event: errorId,
				report: undefined,
				t: undefined,
			},
			resetScroll: false,
		});
	}

	function selectReport(feedbackId: string) {
		navigate({
			to: "/ts_admin/turret/issues/$fingerprint",
			params: { fingerprint },
			search: {
				...search,
				event: undefined,
				report: feedbackId,
				t: undefined,
			},
			resetScroll: false,
		});
	}

	// Replay jumps replace history so Back leaves the issue instead of
	// replaying every position change.
	function setPosition(ts: number) {
		navigate({
			to: "/ts_admin/turret/issues/$fingerprint",
			params: { fingerprint },
			search: { ...search, t: ts },
			replace: true,
			resetScroll: false,
		});
	}

	// An explicit report or occurrence wins; otherwise open the representative
	// occurrence, or the latest report for issues without occurrences.
	const reports = reportsQuery.data?.reports ?? [];
	const selectedErrorId = search.report
		? undefined
		: (search.event ?? issue?.representativeErrorId ?? undefined);
	const selectedReport = selectedErrorId
		? undefined
		: search.report
			? reports.find((report) => report.id === search.report)
			: reports[0];

	const chartData = trendQuery.data?.points ?? [];

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						Issue
					</h1>
					<p className="text-sm text-muted-foreground">
						{fingerprint}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/issues",
								search: {},
							})
						}
					>
						Back to inbox
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => navigate({ to: "/ts_admin/turret" })}
					>
						Dashboard
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/replay-sessions",
								search: {},
							})
						}
					>
						Replay sessions
					</Button>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Summary</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{issueQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : issueQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load issue.
						</div>
					) : !issue ? (
						<div className="text-sm text-muted-foreground">
							Not found (may have expired).
						</div>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant={
										issue.status === "open"
											? "destructive"
											: "secondary"
									}
								>
									{issue.status}
								</Badge>
								{issue.status === "open" &&
								issue.regressedAt !== null ? (
									<Badge variant="destructive">
										regressed
									</Badge>
								) : null}
								<IssueStatusControls
									status={issue.status}
									resolvedInNextDeployment={
										issue.resolvedInVersionId !== null
									}
									canResolveInNextDeployment={
										currentDeploymentId !== null
									}
									disabled={updateMutation.isPending}
									onStatus={setStatus}
									onResolveInNextDeployment={
										resolveInNextDeployment
									}
								/>
							</div>

							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-muted-foreground">
									Priority
								</span>
								{turretIssuePrioritySchema.options.map(
									(priority) => (
										<Button
											key={priority}
											size="sm"
											variant={
												issue.priority === priority
													? "default"
													: "outline"
											}
											type="button"
											aria-pressed={
												issue.priority === priority
											}
											disabled={updateMutation.isPending}
											onClick={() =>
												setPriority(priority)
											}
										>
											{issuePriorityLabels[priority]}
										</Button>
									)
								)}
							</div>
							<IssueOwner
								assigneeId={issue.assigneeId}
								disabled={updateMutation.isPending}
								onAssign={(assigneeId) =>
									updateMutation.mutate({ assigneeId })
								}
							/>
							{updateMutation.isError ? (
								<div className="text-sm text-destructive">
									{updateMutation.error.message}
								</div>
							) : null}

							<div className="grid gap-3 md:grid-cols-2">
								<div className="space-y-1">
									<div className="text-xs text-muted-foreground">
										Title
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<Input
											disabled={updateMutation.isPending}
											value={titleDraft}
											onChange={(e) =>
												setTitleDraft(e.target.value)
											}
											className="min-w-[260px] flex-1"
										/>
										<Button
											type="button"
											disabled={
												updateMutation.isPending ||
												titleDraft.trim() ===
													(
														issue.title ??
														issue.sample.message ??
														""
													).trim()
											}
											onClick={saveTitle}
										>
											Save
										</Button>
									</div>
								</div>
								<div className="space-y-1">
									<div className="text-xs text-muted-foreground">
										Stats
									</div>
									<div className="text-sm">
										<div>
											<span className="text-muted-foreground">
												First seen:
											</span>{" "}
											{new Date(
												issue.firstSeenAt
											).toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">
												Last seen:
											</span>{" "}
											{new Date(
												issue.lastSeenAt
											).toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">
												Occurrences:
											</span>{" "}
											{issue.occurrencesTotal.toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">
												Reports:
											</span>{" "}
											{issue.reportsTotal.toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">
												Users affected:
											</span>{" "}
											{issue.usersAffectedTotal.toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">
												Replay sessions:
											</span>{" "}
											{issue.sessionsAffectedTotal.toLocaleString()}
										</div>
									</div>
								</div>
							</div>

							<IssueResolution
								status={issue.status}
								resolvedAt={issue.resolvedAt}
								regressedAt={issue.regressedAt}
								resolvedInVersionId={issue.resolvedInVersionId}
							/>

							<IssueRecovery fingerprint={fingerprint} />

							<IssueLinks
								fingerprint={fingerprint}
								links={issue.links}
							/>

							<IssueDeployments
								deployments={issue.deployments}
								currentDeploymentId={currentDeploymentId}
								resolvedInVersionId={
									issue.status === "resolved"
										? issue.resolvedInVersionId
										: null
								}
							/>

							<div className="text-xs text-muted-foreground">
								Counts reflect retained events.
								Replay-session-bound events expire with replay
								session retention; non-replay-session worker
								events expire after 24h.
							</div>
						</>
					)}
				</CardContent>
			</Card>

			{issue ? (
				<ExportInvestigation
					fingerprint={fingerprint}
					focus={
						selectedReport
							? { report: selectedReport.id }
							: selectedErrorId
								? { event: selectedErrorId }
								: {}
					}
				/>
			) : null}

			{selectedErrorId ? (
				<IssueInvestigation
					fingerprint={fingerprint}
					errorId={selectedErrorId}
					isRepresentative={
						selectedErrorId === issue?.representativeErrorId
					}
					position={search.t}
					onSelectOccurrence={selectOccurrence}
					onPositionChange={setPosition}
				/>
			) : selectedReport ? (
				<ReportInvestigation
					key={selectedReport.id}
					fingerprint={fingerprint}
					report={selectedReport}
					position={search.t}
					onPositionChange={setPosition}
				/>
			) : search.report && reportsQuery.isSuccess ? (
				<Card>
					<CardContent className="text-sm text-muted-foreground">
						That report is no longer linked to this issue.
					</CardContent>
				</Card>
			) : null}

			{issue ? <IssueActivity fingerprint={fingerprint} /> : null}

			{reports.length > 0 ? (
				<IssueReports
					reports={reports}
					selectedId={selectedReport?.id ?? null}
					pending={linkMutation.isPending}
					error={
						linkMutation.isError ? linkMutation.error.message : null
					}
					onInvestigate={selectReport}
					onUnlink={(feedbackId) =>
						linkMutation.mutate({ action: "unlink", feedbackId })
					}
				/>
			) : null}

			{/* Issues promoted from feedback may have no error occurrences. */}
			{issue?.occurrencesTotal === 0 ? null : (
				<>
					<Card>
						<CardHeader>
							<CardTitle>Trend</CardTitle>
						</CardHeader>
						<CardContent className="space-y-3">
							<div className="flex flex-wrap items-center gap-2">
								{issuePresetSchema.options.map((preset) => (
									<Button
										key={preset}
										variant={
											search.preset === preset
												? "default"
												: "outline"
										}
										type="button"
										onClick={() => setPreset(preset)}
									>
										{preset === "custom"
											? "Custom"
											: `Last ${preset}`}
									</Button>
								))}
								<div className="text-xs text-muted-foreground">
									bucket: {search.bucket}
								</div>
							</div>

							{search.preset === "custom" ? (
								<div className="grid gap-3 md:grid-cols-2">
									<div>
										<div className="text-sm font-medium">
											From
										</div>
										<Input
											type="datetime-local"
											value={toLocalDatetimeValue(
												search.from
											)}
											onChange={(e) => {
												const nextFrom =
													fromLocalDatetimeValue(
														e.target.value
													);
												navigate({
													to: "/ts_admin/turret/issues/$fingerprint",
													params: { fingerprint },
													search: {
														...search,
														from: nextFrom,
													},
												});
											}}
										/>
									</div>
									<div>
										<div className="text-sm font-medium">
											To
										</div>
										<Input
											type="datetime-local"
											value={toLocalDatetimeValue(
												search.to
											)}
											onChange={(e) => {
												const nextTo =
													fromLocalDatetimeValue(
														e.target.value
													);
												navigate({
													to: "/ts_admin/turret/issues/$fingerprint",
													params: { fingerprint },
													search: {
														...search,
														to: nextTo,
													},
												});
											}}
										/>
									</div>
								</div>
							) : null}

							{trendQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading…
								</div>
							) : trendQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load trend.
								</div>
							) : chartData.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No data.
								</div>
							) : (
								<ChartContainer
									config={{
										count: {
											label: "count",
											color: "var(--color-chart-2)",
										},
									}}
									className="aspect-auto h-56 w-full"
								>
									<AreaChart
										data={chartData}
										margin={{
											left: 0,
											right: 0,
											top: 8,
											bottom: 0,
										}}
									>
										<XAxis
											dataKey="bucketStartMs"
											tickFormatter={(v) => {
												const d = new Date(Number(v));
												return search.bucket === "hour"
													? d.toLocaleTimeString(
															undefined,
															{
																hour: "2-digit",
																minute: "2-digit",
															}
														)
													: d.toLocaleDateString();
											}}
											minTickGap={24}
										/>
										<YAxis
											allowDecimals={false}
											width={32}
										/>
										<Tooltip
											formatter={(value) => [
												String(value),
												"count",
											]}
											labelFormatter={(label) =>
												new Date(
													Number(label)
												).toLocaleString()
											}
										/>
										<Area
											type="monotone"
											dataKey="count"
											stroke="var(--color-chart-2)"
											fill="var(--color-chart-2)"
											fillOpacity={0.15}
											strokeWidth={2}
										/>
									</AreaChart>
								</ChartContainer>
							)}
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>Occurrences</CardTitle>
						</CardHeader>
						<CardContent>
							{eventsQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading…
								</div>
							) : eventsQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load occurrences.
								</div>
							) : !eventsQuery.data ||
							  eventsQuery.data.events.length === 0 ? (
								<Empty>
									<EmptyHeader>
										<EmptyTitle>No occurrences</EmptyTitle>
										<EmptyDescription>
											This issue may have fully expired
											under retention.
										</EmptyDescription>
									</EmptyHeader>
									<EmptyContent />
								</Empty>
							) : (
								<>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>When</TableHead>
												<TableHead>Source</TableHead>
												<TableHead>Message</TableHead>
												<TableHead>
													Replay session
												</TableHead>
												<TableHead>
													<span className="sr-only">
														Investigate
													</span>
												</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{eventsQuery.data.events.map(
												(e) => {
													const selected =
														e.id ===
														selectedErrorId;
													return (
														<TableRow
															key={e.id}
															data-state={
																selected
																	? "selected"
																	: undefined
															}
														>
															<TableCell className="whitespace-nowrap">
																{new Date(
																	e.ts
																).toLocaleString()}
															</TableCell>
															<TableCell className="whitespace-nowrap">
																{e.source}
															</TableCell>
															<TableCell className="max-w-[520px] truncate">
																{e.message ??
																	"(no message)"}
															</TableCell>
															<TableCell>
																{e.sessionId ? (
																	<Link
																		to="/ts_admin/turret/replay-sessions/$sessionId"
																		params={{
																			sessionId:
																				e.sessionId,
																		}}
																		search={{
																			t: Math.max(
																				0,
																				e.ts -
																					REPLAY_LEAD_MS
																			),
																		}}
																		className="text-xs underline underline-offset-4"
																	>
																		Open
																	</Link>
																) : (
																	<span className="text-xs text-muted-foreground">
																		-
																	</span>
																)}
															</TableCell>
															<TableCell className="text-right">
																<Button
																	type="button"
																	size="sm"
																	variant={
																		selected
																			? "default"
																			: "outline"
																	}
																	aria-pressed={
																		selected
																	}
																	onClick={() =>
																		selectOccurrence(
																			e.id
																		)
																	}
																>
																	{selected
																		? "Investigating"
																		: "Investigate"}
																</Button>
															</TableCell>
														</TableRow>
													);
												}
											)}
										</TableBody>
									</Table>

									<div className="mt-4 flex items-center justify-between gap-3">
										<Button
											variant="outline"
											disabled={search.eventsOffset <= 0}
											onClick={() =>
												navigate({
													to: "/ts_admin/turret/issues/$fingerprint",
													params: { fingerprint },
													search: {
														...search,
														eventsOffset: Math.max(
															0,
															search.eventsOffset -
																search.eventsLimit
														),
													},
												})
											}
											type="button"
										>
											Prev
										</Button>
										<div className="text-sm text-muted-foreground">
											Showing {search.eventsOffset + 1}–
											{search.eventsOffset +
												eventsQuery.data.events.length}
										</div>
										<Button
											variant="outline"
											disabled={
												eventsQuery.data.events.length <
												search.eventsLimit
											}
											onClick={() =>
												navigate({
													to: "/ts_admin/turret/issues/$fingerprint",
													params: { fingerprint },
													search: {
														...search,
														eventsOffset:
															search.eventsOffset +
															search.eventsLimit,
													},
												})
											}
											type="button"
										>
											Next
										</Button>
									</div>
								</>
							)}
						</CardContent>
					</Card>
				</>
			)}
		</section>
	);
}

function IssueReports(props: {
	reports: TurretIssueReport[];
	selectedId: string | null;
	pending: boolean;
	error: string | null;
	onInvestigate: (feedbackId: string) => void;
	onUnlink: (feedbackId: string) => void;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Reports</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2">
				<p className="text-xs text-muted-foreground">
					Feedback linked to this issue. Unlinking returns a report to
					the feedback inbox; an issue left without occurrences or
					reports no longer appears.
				</p>
				{props.error ? (
					<div className="text-sm text-destructive">
						{props.error}
					</div>
				) : null}
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>When</TableHead>
							<TableHead>Report</TableHead>
							<TableHead>Reporter</TableHead>
							<TableHead>
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{props.reports.map((report) => {
							const selected = report.id === props.selectedId;
							return (
								<TableRow
									key={report.id}
									data-state={
										selected ? "selected" : undefined
									}
								>
									<TableCell className="whitespace-nowrap">
										{new Date(report.ts).toLocaleString()}
									</TableCell>
									<TableCell className="max-w-[520px]">
										<div className="truncate">
											{report.message}
										</div>
										<div className="text-xs text-muted-foreground">
											{report.kind} · {report.status}
											{report.replayAvailable
												? ""
												: " · no replay"}
										</div>
									</TableCell>
									<TableCell className="max-w-[200px] truncate text-xs">
										{report.userEmail ?? report.userId}
									</TableCell>
									<TableCell className="text-right">
										<div className="flex justify-end gap-2">
											<Button
												type="button"
												size="sm"
												variant={
													selected
														? "default"
														: "outline"
												}
												aria-pressed={selected}
												onClick={() =>
													props.onInvestigate(
														report.id
													)
												}
											>
												{selected
													? "Investigating"
													: "Investigate"}
											</Button>
											<Button
												type="button"
												size="sm"
												variant="outline"
												disabled={props.pending}
												onClick={() =>
													props.onUnlink(report.id)
												}
											>
												Unlink
											</Button>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function IssueStatusControls(props: {
	status: TurretIssueStatus;
	resolvedInNextDeployment: boolean;
	canResolveInNextDeployment: boolean;
	disabled: boolean;
	onStatus: (status: TurretIssueStatus) => void;
	onResolveInNextDeployment: () => void;
}) {
	const resolved = props.status === "resolved";
	const buttons = [
		{
			label: "Open",
			active: props.status === "open",
			onClick: () => props.onStatus("open"),
		},
		{
			label: "Resolved",
			active: resolved && !props.resolvedInNextDeployment,
			onClick: () => props.onStatus("resolved"),
		},
		{
			label: "Resolved in next deployment",
			active: resolved && props.resolvedInNextDeployment,
			onClick: props.onResolveInNextDeployment,
			unavailable: !props.canResolveInNextDeployment,
		},
		{
			label: "Ignored",
			active: props.status === "ignored",
			onClick: () => props.onStatus("ignored"),
		},
	];
	return (
		<>
			{buttons.map((button) => (
				<Button
					key={button.label}
					variant={button.active ? "default" : "outline"}
					type="button"
					aria-pressed={button.active}
					disabled={props.disabled || button.unavailable}
					title={
						button.unavailable
							? "This runtime doesn't report its deployment."
							: undefined
					}
					onClick={button.onClick}
				>
					{button.label}
				</Button>
			))}
		</>
	);
}

function shortDeployment(id: string) {
	return id.slice(0, 8);
}

function IssueDeployments(props: {
	deployments: Array<{
		deploymentId: string | null;
		occurrences: number;
		firstSeenAt: number;
		lastSeenAt: number;
	}>;
	currentDeploymentId: string | null;
	resolvedInVersionId: string | null;
}) {
	if (props.deployments.length === 0) return null;
	return (
		<div className="space-y-1">
			<div className="text-xs text-muted-foreground">
				Occurrences by deployment
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Deployment</TableHead>
						<TableHead className="text-right">
							Occurrences
						</TableHead>
						<TableHead>First seen</TableHead>
						<TableHead>Last seen</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{props.deployments.map((d) => (
						<TableRow key={d.deploymentId ?? "unknown"}>
							<TableCell>
								<div className="flex flex-wrap items-center gap-2">
									<span
										className="font-mono text-xs"
										title={d.deploymentId ?? undefined}
									>
										{d.deploymentId
											? shortDeployment(d.deploymentId)
											: "Unknown"}
									</span>
									{d.deploymentId &&
									d.deploymentId ===
										props.currentDeploymentId ? (
										<Badge variant="outline">current</Badge>
									) : null}
									{d.deploymentId &&
									d.deploymentId ===
										props.resolvedInVersionId ? (
										<Badge variant="secondary">
											fix pending
										</Badge>
									) : null}
								</div>
							</TableCell>
							<TableCell className="text-right tabular-nums">
								{d.occurrences.toLocaleString()}
							</TableCell>
							<TableCell>
								{new Date(d.firstSeenAt).toLocaleString()}
							</TableCell>
							<TableCell>
								{new Date(d.lastSeenAt).toLocaleString()}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function IssueResolution(props: {
	status: TurretIssueStatus;
	resolvedAt: number | null;
	regressedAt: number | null;
	resolvedInVersionId: string | null;
}) {
	if (props.status === "open" && props.regressedAt !== null)
		return (
			<div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
				<span className="font-medium">Regressed.</span> It occurred
				again at {new Date(props.regressedAt).toLocaleString()}
				{props.resolvedAt !== null
					? ` after being resolved at ${new Date(props.resolvedAt).toLocaleString()}`
					: ""}
				. Resolve it again once the fix is deployed.
			</div>
		);
	if (props.status === "resolved")
		return (
			<div className="text-sm text-muted-foreground">
				Resolved
				{props.resolvedAt !== null
					? ` at ${new Date(props.resolvedAt).toLocaleString()}`
					: ""}
				.{" "}
				{props.resolvedInVersionId
					? `Occurrences from deployment ${shortDeployment(props.resolvedInVersionId)} are expected until the fix ships; an occurrence from any other deployment reopens this issue as regressed.`
					: "A later occurrence reopens this issue as regressed."}{" "}
				An absence of new occurrences doesn't confirm the fix unless the
				affected flow has been used since.
			</div>
		);
	return null;
}

export { Route };
