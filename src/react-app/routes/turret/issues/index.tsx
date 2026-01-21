import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

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

import { requireTurretAdmin } from "../../../lib/requireTurretAdmin";
import { turretIssuesQueryOptions } from "../../../queries/turretQueries";
import type { TurretIssueStatus } from "../../../lib/turretApi";

type RangePreset = "24h" | "7d" | "30d" | "custom";

function presetToRange(preset: RangePreset, now: number): { from?: number; to?: number } {
	switch (preset) {
		case "24h":
			return { from: now - 24 * 60 * 60 * 1000, to: now };
		case "7d":
			return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
		case "30d":
			return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
		case "custom":
		default:
			return {};
	}
}

function toLocalDatetimeValue(ms?: number): string {
	if (!ms || Number.isNaN(ms)) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetimeValue(v: string): number | undefined {
	if (!v) return undefined;
	const d = new Date(v);
	const ms = d.getTime();
	return Number.isNaN(ms) ? undefined : ms;
}

const Route = createFileRoute("/turret/issues/")({
	validateSearch: (s: Record<string, unknown>) => {
		const status: TurretIssueStatus =
			s.status === "resolved" || s.status === "ignored" || s.status === "open"
				? (s.status as TurretIssueStatus)
				: "open";
		const preset: RangePreset =
			s.preset === "24h" || s.preset === "7d" || s.preset === "30d" || s.preset === "custom"
				? (s.preset as RangePreset)
				: "24h";
		return {
			status,
			preset,
			q: typeof s.q === "string" ? s.q : "",
			from: typeof s.from === "string" ? Number(s.from) : undefined,
			to: typeof s.to === "string" ? Number(s.to) : undefined,
			offset: typeof s.offset === "string" ? Number(s.offset) : 0,
			limit: typeof s.limit === "string" ? Number(s.limit) : 50,
		};
	},
	beforeLoad: requireTurretAdmin,
	component: TurretIssuesPage,
});

function TurretIssuesPage() {
	const navigate = useNavigate();
	const search = Route.useSearch();
	const [now] = useState(() => Date.now());

	const range = useMemo(() => {
		if (search.preset === "custom") return { from: search.from, to: search.to };
		return presetToRange(search.preset, now);
	}, [now, search.from, search.preset, search.to]);

	const issuesQuery = useQuery(
		turretIssuesQueryOptions({
			status: search.status,
			q: search.q || undefined,
			from: range.from,
			to: range.to,
			limit: search.limit,
			offset: search.offset,
		})
	);

	const [qInput, setQInput] = useState(search.q);
	useEffect(() => {
		setQInput(search.q);
	}, [search.q]);

	function setStatus(status: TurretIssueStatus) {
		navigate({
			to: "/turret/issues",
			search: {
				...search,
				status,
				offset: 0,
			},
		});
	}

	function setPreset(preset: RangePreset) {
		const next = preset === "custom" ? { from: search.from, to: search.to } : presetToRange(preset, now);
		navigate({
			to: "/turret/issues",
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
			to: "/turret/issues",
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
					<h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
					<p className="text-sm text-muted-foreground">Grouped errors by fingerprint (time-windowed).</p>
				</div>
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" onClick={() => navigate({ to: "/turret" })}>
						Dashboard
					</Button>
					<Button type="button" variant="outline" onClick={() => navigate({ to: "/turret/sessions", search: { q: "", hasError: false, groupBy: "none", preset: "1h", from: undefined, to: undefined, offset: 0, limit: 50 } })}>
						Sessions
					</Button>
					<Button type="button" variant="outline" onClick={() => navigate({ to: "/turret/settings" })}>
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
						<Button variant={search.status === "open" ? "default" : "outline"} type="button" onClick={() => setStatus("open")}>
							Open
						</Button>
						<Button variant={search.status === "resolved" ? "default" : "outline"} type="button" onClick={() => setStatus("resolved")}>
							Resolved
						</Button>
						<Button variant={search.status === "ignored" ? "default" : "outline"} type="button" onClick={() => setStatus("ignored")}>
							Ignored
						</Button>
						<div className="mx-2 hidden h-6 w-px bg-border sm:block" />
						<Button variant={search.preset === "24h" ? "default" : "outline"} type="button" onClick={() => setPreset("24h")}>
							Last 24h
						</Button>
						<Button variant={search.preset === "7d" ? "default" : "outline"} type="button" onClick={() => setPreset("7d")}>
							Last 7d
						</Button>
						<Button variant={search.preset === "30d" ? "default" : "outline"} type="button" onClick={() => setPreset("30d")}>
							Last 30d
						</Button>
						<Button variant={search.preset === "custom" ? "default" : "outline"} type="button" onClick={() => setPreset("custom")}>
							Custom
						</Button>
						<div className="text-xs text-muted-foreground">{formatRangeLabel()}</div>
					</div>

					{search.preset === "custom" ? (
						<div className="grid gap-3 md:grid-cols-2">
							<div>
								<div className="text-sm font-medium">From</div>
								<Input
									type="datetime-local"
									value={toLocalDatetimeValue(search.from)}
									onChange={(e) => {
										const nextFrom = fromLocalDatetimeValue(e.target.value);
										navigate({ to: "/turret/issues", search: { ...search, from: nextFrom } });
									}}
								/>
							</div>
							<div>
								<div className="text-sm font-medium">To</div>
								<Input
									type="datetime-local"
									value={toLocalDatetimeValue(search.to)}
									onChange={(e) => {
										const nextTo = fromLocalDatetimeValue(e.target.value);
										navigate({ to: "/turret/issues", search: { ...search, to: nextTo } });
									}}
								/>
							</div>
						</div>
					) : null}

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
						<div className="text-sm text-muted-foreground">Loading…</div>
					) : issuesQuery.isError ? (
						<div className="text-sm text-destructive">Failed to load issues.</div>
					) : (issuesQuery.data?.issues.length ?? 0) === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No issues found</EmptyTitle>
								<EmptyDescription>
									Try widening your time range or clearing filters.
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
									<TableHead>Last seen</TableHead>
									<TableHead>Occurrences</TableHead>
									<TableHead>Sessions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(issuesQuery.data?.issues ?? []).map((i) => {
									const last = new Date(i.lastSeenAt).toLocaleString();
									return (
										<TableRow
											key={i.fingerprint}
											className="cursor-pointer"
											onClick={() =>
												navigate({
													to: "/turret/issues/$fingerprint",
													params: { fingerprint: i.fingerprint },
													search: { preset: "7d", bucket: "day", from: undefined, to: undefined, eventsOffset: 0, eventsLimit: 50 },
												})
											}
										>
											<TableCell className="max-w-[520px]">
												<div className="truncate font-medium">{i.title ?? i.sample.message ?? "(no title)"}</div>
												<div className="truncate text-xs text-muted-foreground">{i.fingerprint}</div>
											</TableCell>
											<TableCell>
												<Badge variant={i.status === "open" ? "destructive" : "secondary"}>
													{i.status}
												</Badge>
											</TableCell>
											<TableCell>{last}</TableCell>
											<TableCell>{i.occurrences.toLocaleString()}</TableCell>
											<TableCell>{i.sessionsAffected.toLocaleString()}</TableCell>
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
										to: "/turret/issues",
										search: { ...search, offset: Math.max(0, search.offset - search.limit) },
									})
								}
								type="button"
							>
								Prev
							</Button>
							<div className="text-sm text-muted-foreground">
								Showing {search.offset + 1}–{search.offset + (issuesQuery.data.issues.length ?? 0)}
							</div>
							<Button
								variant="outline"
								disabled={issuesQuery.data.issues.length < search.limit}
								onClick={() =>
									navigate({
										to: "/turret/issues",
										search: { ...search, offset: search.offset + search.limit },
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
