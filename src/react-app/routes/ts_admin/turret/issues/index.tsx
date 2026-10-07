import {
	turretIssueSortSchema,
	turretIssueViewSchema,
	type TurretIssueSort,
	type TurretIssueView,
} from "@/contracts/turret";
import {
	issuesSearchSchema,
	issuePresetSchema,
	issueViewLabels,
	issueSortLabels,
	issueAssigneeFilterLabels,
	issuePriorityLabels,
	formatOccurrenceChange,
	type IssueRangePreset as RangePreset,
} from "../../../../features/turret/issueSearch";
import {
	presetToRange,
	toLocalDatetimeValue,
	fromLocalDatetimeValue,
} from "../../../../features/turret/timeRange";

import { useDraftValue } from "@/react-app/hooks/useDraftValue";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

import {
	turretAssigneesQueryOptions,
	turretIssuesQueryOptions,
} from "../../../../features/turret/queries";

const Route = createFileRoute("/ts_admin/turret/issues/")({
	validateSearch: issuesSearchSchema,
	component: TurretIssuesPage,
});

function TurretIssuesPage() {
	const navigate = useNavigate();
	const search = Route.useSearch();
	const [now] = useState(() => Date.now());

	const range = useMemo(() => {
		if (search.preset === "custom")
			return { from: search.from, to: search.to };
		return presetToRange(search.preset, now);
	}, [now, search.from, search.preset, search.to]);

	const issuesQuery = useQuery(
		turretIssuesQueryOptions({
			status: search.status,
			sort: search.sort,
			assignee: search.assignee,
			q: search.q || undefined,
			from: range.from,
			to: range.to,
			limit: search.limit,
			offset: search.offset,
		})
	);

	const { value: qInput, setValue: setQInput } = useDraftValue(
		search.q,
		search.q
	);

	function setStatus(status: TurretIssueView) {
		navigate({
			to: "/ts_admin/turret/issues",
			search: {
				...search,
				status,
				offset: 0,
			},
		});
	}

	const assigneesQuery = useQuery(turretAssigneesQueryOptions);
	const ownerNames = new Map(
		(assigneesQuery.data?.assignees ?? []).map((user) => [
			user.id,
			user.name || user.email,
		])
	);

	function setAssignee(assignee: "me" | "none" | undefined) {
		navigate({
			to: "/ts_admin/turret/issues",
			search: { ...search, assignee, offset: 0 },
		});
	}

	function setSort(sort: TurretIssueSort) {
		navigate({
			to: "/ts_admin/turret/issues",
			search: { ...search, sort, offset: 0 },
		});
	}

	function setPreset(preset: RangePreset) {
		const next =
			preset === "custom"
				? { from: search.from, to: search.to }
				: presetToRange(preset, now);
		navigate({
			to: "/ts_admin/turret/issues",
			search: {
				...search,
				preset,
				from: next.from,
				to: next.to,
				offset: 0,
			},
		});
	}

	function applyFilters() {
		navigate({
			to: "/ts_admin/turret/issues",
			search: {
				...search,
				q: qInput,
				offset: 0,
			},
		});
	}

	function formatRangeLabel(): string {
		if (search.preset !== "custom") return search.preset;
		const from = search.from ? new Date(search.from).toLocaleString() : "-";
		const to = search.to ? new Date(search.to).toLocaleString() : "-";
		return `${from} → ${to}`;
	}

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						Issues
					</h1>
					<p className="text-sm text-muted-foreground">
						Grouped errors by fingerprint. Counts cover the selected
						window; changes compare it with the window before.
					</p>
				</div>
				<div className="flex items-center gap-2">
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
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({ to: "/ts_admin/turret/settings" })
						}
					>
						Settings
					</Button>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Filters</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap items-center gap-2">
						{turretIssueViewSchema.options.map((status) => (
							<Button
								key={status}
								variant={
									search.status === status
										? "default"
										: "outline"
								}
								type="button"
								onClick={() => setStatus(status)}
							>
								{issueViewLabels[status]}
							</Button>
						))}
						<div className="mx-2 hidden h-6 w-px bg-border sm:block" />
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
							{formatRangeLabel()}
						</div>
					</div>

					{search.preset === "custom" ? (
						<div className="grid gap-3 md:grid-cols-2">
							<div>
								<div className="text-sm font-medium">From</div>
								<Input
									type="datetime-local"
									value={toLocalDatetimeValue(search.from)}
									onChange={(e) => {
										const nextFrom = fromLocalDatetimeValue(
											e.target.value
										);
										navigate({
											to: "/ts_admin/turret/issues",
											search: {
												...search,
												from: nextFrom,
											},
										});
									}}
								/>
							</div>
							<div>
								<div className="text-sm font-medium">To</div>
								<Input
									type="datetime-local"
									value={toLocalDatetimeValue(search.to)}
									onChange={(e) => {
										const nextTo = fromLocalDatetimeValue(
											e.target.value
										);
										navigate({
											to: "/ts_admin/turret/issues",
											search: { ...search, to: nextTo },
										});
									}}
								/>
							</div>
						</div>
					) : null}

					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm text-muted-foreground">
							Owner
						</span>
						{(["anyone", "me", "none"] as const).map((filter) => {
							const value =
								filter === "anyone" ? undefined : filter;
							return (
								<Button
									key={filter}
									size="sm"
									variant={
										search.assignee === value
											? "default"
											: "outline"
									}
									type="button"
									onClick={() => setAssignee(value)}
								>
									{issueAssigneeFilterLabels[filter]}
								</Button>
							);
						})}
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm text-muted-foreground">
							Sort by
						</span>
						{turretIssueSortSchema.options.map((sort) => (
							<Button
								key={sort}
								size="sm"
								variant={
									search.sort === sort ? "default" : "outline"
								}
								type="button"
								onClick={() => setSort(sort)}
							>
								{issueSortLabels[sort]}
							</Button>
						))}
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<div className="flex min-w-[240px] flex-1 flex-wrap items-center gap-2">
							<Input
								className="min-w-[220px] flex-1"
								placeholder="Search title, message, or stack…"
								value={qInput}
								onChange={(e) => setQInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") applyFilters();
								}}
							/>
							<Button type="button" onClick={applyFilters}>
								Apply
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Issues</CardTitle>
				</CardHeader>
				<CardContent>
					{issuesQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : issuesQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load issues.
						</div>
					) : (issuesQuery.data?.issues.length ?? 0) === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No issues found</EmptyTitle>
								<EmptyDescription>
									Try widening your time range or clearing
									filters.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent />
						</Empty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Title</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Owner</TableHead>
									<TableHead className="text-right">
										Users
									</TableHead>
									<TableHead className="text-right">
										Replay sessions
									</TableHead>
									<TableHead className="text-right">
										Occurrences
									</TableHead>
									<TableHead>First seen</TableHead>
									<TableHead>Last seen</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(issuesQuery.data?.issues ?? []).map((i) => {
									const last = new Date(
										i.lastSeenAt
									).toLocaleString();
									const firstSeenInWindow =
										range.from !== undefined &&
										i.firstSeenAt >= range.from;
									return (
										<TableRow
											key={i.fingerprint}
											className="cursor-pointer"
											onClick={() =>
												navigate({
													to: "/ts_admin/turret/issues/$fingerprint",
													params: {
														fingerprint:
															i.fingerprint,
													},
													search: {},
												})
											}
										>
											<TableCell className="max-w-[520px]">
												<div className="truncate font-medium">
													{i.title ??
														i.sample.message ??
														"(no title)"}
												</div>
												<div className="truncate text-xs text-muted-foreground">
													{i.fingerprint}
												</div>
											</TableCell>
											<TableCell>
												<div className="flex flex-wrap gap-1">
													<Badge
														variant={
															i.status === "open"
																? "destructive"
																: "secondary"
														}
													>
														{i.status}
													</Badge>
													{i.status === "open" &&
													i.regressedAt !== null ? (
														<Badge
															variant="destructive"
															title={`Occurred again at ${new Date(i.regressedAt).toLocaleString()} after resolution`}
														>
															regressed
														</Badge>
													) : null}
													{i.priority !== "medium" ? (
														<Badge
															variant={
																i.priority ===
																"high"
																	? "default"
																	: "outline"
															}
														>
															{issuePriorityLabels[
																i.priority
															].toLowerCase()}{" "}
															priority
														</Badge>
													) : null}
												</div>
											</TableCell>
											<TableCell className="max-w-[160px] truncate text-sm">
												{i.assigneeId ? (
													(ownerNames.get(
														i.assigneeId
													) ?? i.assigneeId)
												) : (
													<span className="text-muted-foreground">
														—
													</span>
												)}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{i.usersAffected.toLocaleString()}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{i.sessionsAffected.toLocaleString()}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												<div>
													{i.occurrences.toLocaleString()}
												</div>
												<div
													className="text-xs text-muted-foreground"
													title={`${i.previousOccurrences.toLocaleString()} in the previous window`}
												>
													{formatOccurrenceChange(
														i.occurrences,
														i.previousOccurrences
													)}
												</div>
											</TableCell>
											<TableCell>
												<div>
													{new Date(
														i.firstSeenAt
													).toLocaleString()}
												</div>
												{firstSeenInWindow ? (
													<div className="text-xs text-muted-foreground">
														new in this window
													</div>
												) : null}
											</TableCell>
											<TableCell>{last}</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}

					{issuesQuery.data ? (
						<div className="mt-4 flex items-center justify-between gap-3">
							<Button
								variant="outline"
								disabled={search.offset <= 0}
								onClick={() =>
									navigate({
										to: "/ts_admin/turret/issues",
										search: {
											...search,
											offset: Math.max(
												0,
												search.offset - search.limit
											),
										},
									})
								}
								type="button"
							>
								Prev
							</Button>
							<div className="text-sm text-muted-foreground">
								Showing {search.offset + 1}–
								{search.offset +
									(issuesQuery.data.issues.length ?? 0)}
							</div>
							<Button
								variant="outline"
								disabled={
									issuesQuery.data.issues.length <
									search.limit
								}
								onClick={() =>
									navigate({
										to: "/ts_admin/turret/issues",
										search: {
											...search,
											offset:
												search.offset + search.limit,
										},
									})
								}
								type="button"
							>
								Next
							</Button>
						</div>
					) : null}
				</CardContent>
			</Card>
		</section>
	);
}

export { Route };
