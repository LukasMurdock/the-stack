import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

import { requireTurretAdmin } from "../../../lib/requireTurretAdmin";
import {
	turretIssueEventsQueryOptions,
	turretIssueQueryOptions,
	turretIssueTrendQueryOptions,
} from "../../../queries/turretQueries";
import { patchIssue, type TurretIssueStatus } from "../../../lib/turretApi";

const CLOUDFLARE_TRACES_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/traces";

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

function parseJsonObject(input: string | null): Record<string, unknown> | null {
	if (!input) return null;
	try {
		const parsed = JSON.parse(input) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

const Route = createFileRoute("/turret/issues/$fingerprint")({
	validateSearch: (s: Record<string, unknown>) => {
		const preset: RangePreset =
			s.preset === "24h" || s.preset === "7d" || s.preset === "30d" || s.preset === "custom"
				? (s.preset as RangePreset)
				: "7d";
		const bucket: "hour" | "day" = s.bucket === "hour" || s.bucket === "day" ? (s.bucket as any) : (preset === "24h" ? "hour" : "day");
		return {
			preset,
			bucket,
			from: typeof s.from === "string" ? Number(s.from) : undefined,
			to: typeof s.to === "string" ? Number(s.to) : undefined,
			eventsOffset: typeof s.eventsOffset === "string" ? Number(s.eventsOffset) : 0,
			eventsLimit: typeof s.eventsLimit === "string" ? Number(s.eventsLimit) : 50,
		};
	},
	beforeLoad: requireTurretAdmin,
	component: TurretIssueDetailPage,
});

function TurretIssueDetailPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { fingerprint } = Route.useParams();
	const search = Route.useSearch();
	const [now] = useState(() => Date.now());

	const range = useMemo(() => {
		if (search.preset === "custom") return { from: search.from, to: search.to };
		return presetToRange(search.preset, now);
	}, [now, search.from, search.preset, search.to]);

	const issueQuery = useQuery(turretIssueQueryOptions(fingerprint));
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

	const [titleDraft, setTitleDraft] = useState<string>("");
	useEffect(() => {
		if (!issue) return;
		setTitleDraft(issue.title ?? issue.sample.message ?? "");
	}, [issue?.fingerprint, issue?.title, issue?.sample.message]);

	const updateMutation = useMutation({
		mutationFn: (input: { fingerprint: string; update: { status?: TurretIssueStatus; title?: string | null } }) =>
			patchIssue(input.fingerprint, input.update),
		onSuccess: async () => {
		await qc.invalidateQueries({ queryKey: ["turret", "issues"] });
		await qc.invalidateQueries({ queryKey: ["turret", "issue", fingerprint] });
		await qc.invalidateQueries({ queryKey: ["turret", "issue", fingerprint, "trend"] });
		await qc.invalidateQueries({ queryKey: ["turret", "issue", fingerprint, "events"] });
	},
	});

	function setPreset(preset: RangePreset) {
		const next = preset === "custom" ? { from: search.from, to: search.to } : presetToRange(preset, now);
		const nextBucket = preset === "24h" ? "hour" : "day";
		navigate({
			to: "/turret/issues/$fingerprint",
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
		updateMutation.mutate({ fingerprint, update: { title: next } });
	}

	function setStatus(status: TurretIssueStatus) {
		updateMutation.mutate({ fingerprint, update: { status } });
	}

	const chartData = trendQuery.data?.points ?? [];

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Issue</h1>
					<p className="text-sm text-muted-foreground">{fingerprint}</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/turret/issues",
								search: { status: "open", preset: "24h", q: "", from: undefined, to: undefined, offset: 0, limit: 50 },
							})
						}
					>
						Back to inbox
					</Button>
					<Button type="button" variant="outline" onClick={() => navigate({ to: "/turret" })}>
						Dashboard
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/turret/sessions",
								search: { q: "", hasError: false, groupBy: "none", preset: "1h", from: undefined, to: undefined, offset: 0, limit: 50 },
							})
						}
					>
						Sessions
					</Button>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Summary</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{issueQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">Loading…</div>
					) : issueQuery.isError ? (
						<div className="text-sm text-destructive">Failed to load issue.</div>
					) : !issue ? (
						<div className="text-sm text-muted-foreground">Not found (may have expired).</div>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant={issue.status === "open" ? "destructive" : "secondary"}>
									{issue.status}
								</Badge>
								<Button
									variant={issue.status === "open" ? "default" : "outline"}
									type="button"
									disabled={updateMutation.isPending}
									onClick={() => setStatus("open")}
								>
									Open
								</Button>
								<Button
									variant={issue.status === "resolved" ? "default" : "outline"}
									type="button"
									disabled={updateMutation.isPending}
									onClick={() => setStatus("resolved")}
								>
									Resolved
								</Button>
								<Button
									variant={issue.status === "ignored" ? "default" : "outline"}
									type="button"
									disabled={updateMutation.isPending}
									onClick={() => setStatus("ignored")}
								>
									Ignored
								</Button>
							</div>

							<div className="grid gap-3 md:grid-cols-2">
								<div className="space-y-1">
									<div className="text-xs text-muted-foreground">Title</div>
									<div className="flex flex-wrap items-center gap-2">
										<Input
											value={titleDraft}
											onChange={(e) => setTitleDraft(e.target.value)}
											className="min-w-[260px] flex-1"
										/>
										<Button
											type="button"
											disabled={updateMutation.isPending || titleDraft.trim() === (issue.title ?? issue.sample.message ?? "").trim()}
											onClick={saveTitle}
										>
											Save
										</Button>
									</div>
								</div>
								<div className="space-y-1">
									<div className="text-xs text-muted-foreground">Stats</div>
									<div className="text-sm">
										<div>
											<span className="text-muted-foreground">First seen:</span> {new Date(issue.firstSeenAt).toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">Last seen:</span> {new Date(issue.lastSeenAt).toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">Occurrences:</span> {issue.occurrencesTotal.toLocaleString()}
										</div>
										<div>
											<span className="text-muted-foreground">Sessions:</span> {issue.sessionsAffectedTotal.toLocaleString()}
										</div>
									</div>
							</div>
						</div>

							<div className="text-xs text-muted-foreground">
								Counts reflect retained events. Session-bound events expire with session retention; non-session worker events expire after 24h.
							</div>
						</>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Trend</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
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
						<div className="text-xs text-muted-foreground">bucket: {search.bucket}</div>
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
										navigate({ to: "/turret/issues/$fingerprint", params: { fingerprint }, search: { ...search, from: nextFrom } });
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
										navigate({ to: "/turret/issues/$fingerprint", params: { fingerprint }, search: { ...search, to: nextTo } });
									}}
								/>
							</div>
						</div>
					) : null}

					{trendQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">Loading…</div>
					) : trendQuery.isError ? (
						<div className="text-sm text-destructive">Failed to load trend.</div>
					) : chartData.length === 0 ? (
						<div className="text-sm text-muted-foreground">No data.</div>
					) : (
						<ChartContainer config={{ count: { label: "count", color: "var(--color-chart-2)" } }} className="aspect-auto h-56 w-full">
							<AreaChart data={chartData as any} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
								<XAxis
									dataKey="bucketStartMs"
									tickFormatter={(v) => {
										const d = new Date(Number(v));
										return search.bucket === "hour"
											? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
											: d.toLocaleDateString();
									}}
									minTickGap={24}
								/>
								<YAxis allowDecimals={false} width={32} />
								<Tooltip
									formatter={(value: any) => [String(value), "count"]}
									labelFormatter={(label: any) => new Date(Number(label)).toLocaleString()}
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
						<div className="text-sm text-muted-foreground">Loading…</div>
					) : eventsQuery.isError ? (
						<div className="text-sm text-destructive">Failed to load occurrences.</div>
					) : !eventsQuery.data || eventsQuery.data.events.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No occurrences</EmptyTitle>
								<EmptyDescription>
									This issue may have fully expired under retention.
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
										<TableHead>Session</TableHead>
										<TableHead>Trace</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{eventsQuery.data.events.map((e) => {
										const extra = parseJsonObject(e.extraJson);
										const rayId = typeof extra?.ray_id === "string" ? extra.ray_id : null;
										return (
											<TableRow key={e.id}>
												<TableCell className="whitespace-nowrap">{new Date(e.ts).toLocaleString()}</TableCell>
												<TableCell className="whitespace-nowrap">{e.source}</TableCell>
												<TableCell className="max-w-[520px] truncate">{e.message ?? "(no message)"}</TableCell>
												<TableCell>
													{e.sessionId ? (
														<Button
															variant="outline"
															type="button"
															onClick={() =>
																navigate({
																	to: "/turret/sessions/$sessionId",
																	params: { sessionId: e.sessionId as string },
																})
															}
														>
															Open
														</Button>
													) : (
														<span className="text-xs text-muted-foreground">-</span>
													)}
												</TableCell>
												<TableCell>
													{rayId ? (
														<div className="flex items-center gap-2">
															<button
																type="button"
																className="rounded-md border px-2.5 py-1 text-xs"
																onClick={() => {
																	try {
																		void navigator.clipboard.writeText(rayId);
																	} catch {
																		// ignore
																	}
																}}
															>
																Copy ray
															</button>
															<a
																href={CLOUDFLARE_TRACES_URL}
																target="_blank"
																rel="noreferrer"
																className="rounded-md border px-2.5 py-1 text-xs"
																title="Open Cloudflare Traces (search by ray id)"
															>
																Trace
															</a>
														</div>
													) : (
														<span className="text-xs text-muted-foreground">-</span>
													)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>

							<div className="mt-4 flex items-center justify-between gap-3">
								<Button
									variant="outline"
									disabled={search.eventsOffset <= 0}
									onClick={() =>
										navigate({
											to: "/turret/issues/$fingerprint",
											params: { fingerprint },
											search: { ...search, eventsOffset: Math.max(0, search.eventsOffset - search.eventsLimit) },
									})
								}
									type="button"
								>
									Prev
								</Button>
								<div className="text-sm text-muted-foreground">
									Showing {search.eventsOffset + 1}–{search.eventsOffset + eventsQuery.data.events.length}
								</div>
								<Button
									variant="outline"
									disabled={eventsQuery.data.events.length < search.eventsLimit}
									onClick={() =>
										navigate({
											to: "/turret/issues/$fingerprint",
											params: { fingerprint },
											search: { ...search, eventsOffset: search.eventsOffset + search.eventsLimit },
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
		</section>
	);
}

export { Route };
