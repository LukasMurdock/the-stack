import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
	turretSessionsQueryOptions,
	turretDashboardUsersQueryOptions,
	turretIssuesQueryOptions,
	turretUptimeQueryOptions,
} from "../../../queries/turretQueries";

import { requireTurretAdmin } from "../../../lib/requireTurretAdmin";

const Route = createFileRoute("/ts_admin/turret/")({
	beforeLoad: requireTurretAdmin,
	component: TurretDashboardPage,
});

function TurretDashboardPage() {
	const navigate = useNavigate();
	const defaultSessionsSearch = {
		q: "",
		hasError: false,
		groupBy: "none" as const,
		preset: "1h" as const,
		from: undefined as number | undefined,
		to: undefined as number | undefined,
		offset: 0,
		limit: 50,
	};
	const uptimeQuery = useQuery(turretUptimeQueryOptions);

	// Anchor time for this mount so the queryKey stays stable.
	const [now] = useState(() => Date.now());
	const openIssuesQuery = useQuery(
		turretIssuesQueryOptions({
			status: "open",
			from: now - 24 * 60 * 60 * 1000,
			to: now,
			limit: 50,
			offset: 0,
		})
	);
	const dashboardUsersQuery = useQuery(turretDashboardUsersQueryOptions({ to: now }));
	const sessionsPreviewQuery = useQuery(
		turretSessionsQueryOptions({
			from: now - 60 * 60 * 1000,
			to: now,
			limit: 10,
			offset: 0,
		})
	)
	const recentUsersQuery = useQuery(
		turretSessionsQueryOptions({
			from: now - 24 * 60 * 60 * 1000,
			to: now,
			limit: 200,
			offset: 0,
		})
	)

	const sessions = sessionsPreviewQuery.data?.sessions ?? [];
	const errorCount = sessions.filter((s) => s.hasError).length;
	const captureBlockedCount = sessions.filter((s) => s.captureBlocked).length;
	const openIssuesCount = openIssuesQuery.data?.issues.length;
	const openIssuesLabel =
		openIssuesQuery.isLoading
			? "…"
			: openIssuesQuery.isError
				? "-"
				: openIssuesCount != null
					? openIssuesCount >= 50
						? "50+"
						: String(openIssuesCount)
					: "-";

	const dashboard = dashboardUsersQuery.data;
	const recentUserRows = useMemo(() => {
		const sessions = recentUsersQuery.data?.sessions ?? [];
		const out = [] as typeof sessions;
		const seen = new Set<string>();
		for (const s of sessions) {
			const key = s.userId;
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(s);
			if (out.length >= 10) break;
		}
		return out;
	}, [recentUsersQuery.data?.sessions]);

	function formatCompact(n: number): string {
		try {
			return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
		} catch {
			return String(n);
		}
	}

	function formatPct(pct: number): string {
		const sign = pct > 0 ? "+" : "";
		return `${sign}${pct.toFixed(0)}%`;
	}

	function DeltaLine(props: { pct: number | null | undefined; label: string }) {
		if (props.pct == null || !Number.isFinite(props.pct)) {
			return <div className="text-xs text-muted-foreground">{props.label}: n/a</div>;
		}
		const positive = props.pct >= 0;
		return (
			<div
				className={
					"text-xs " +
					(positive
						? "text-emerald-700 dark:text-emerald-300"
						: "text-rose-700 dark:text-rose-300")
				}
			>
				{formatPct(props.pct)} {props.label}
			</div>
		)
	}

	function formatUserDevice(uaRaw: string | null): string {
		const ua = uaRaw ?? "";
		if (!ua) return "-";
		const isIOS = /iPhone|iPad|iPod/i.test(ua);
		const isAndroid = /Android/i.test(ua);
		const isMac = /Macintosh/i.test(ua);
		const isWindows = /Windows/i.test(ua);
		const isLinux = /Linux/i.test(ua) && !isAndroid;

		let os = "";
		if (isIOS) os = "iOS";
		else if (isAndroid) os = "Android";
		else if (isMac) os = "Mac";
		else if (isWindows) os = "Windows";
		else if (isLinux) os = "Linux";
		else os = "Other";

		let browser = "";
		if (/Edg\//.test(ua)) browser = "Edge";
		else if (/Firefox\//.test(ua)) browser = "Firefox";
		else if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) browser = "Chrome";
		else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
		else browser = "Browser";

		return `${browser} · ${os}`;
	}

	type Point = { weekStartMs: number; value: number };
	type PointNullable = { weekStartMs: number; value: number | null };

	function SparkArea(props: { data: Array<Point | PointNullable>; valueKey: string }) {
		return (
			<ChartContainer
				config={{ v: { label: "value", color: "var(--color-chart-2)" } }}
				className="aspect-auto h-24 w-full"
			>
				<AreaChart data={props.data as any} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
					<XAxis dataKey="weekStartMs" hide />
					<YAxis hide />
					<Tooltip wrapperStyle={{ display: "none" }} />
					<Area
						type="monotone"
						dataKey={props.valueKey}
						stroke="var(--color-chart-2)"
						fill="var(--color-chart-2)"
						fillOpacity={0.15}
						strokeWidth={2}
						connectNulls
					/>
				</AreaChart>
			</ChartContainer>
		)
	}

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Turret</h1>
					<p className="text-sm text-muted-foreground">
						Internal observability dashboard.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/issues",
								search: { status: "open", preset: "24h", q: "", from: undefined, to: undefined, offset: 0, limit: 50 },
							})
						}
					>
						Issues
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => navigate({ to: "/ts_admin/turret/settings" })}
					>
						Settings
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/sessions",
								search: defaultSessionsSearch,
							})
						}
					>
						View sessions
					</Button>
				</div>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle>Uptime</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{uptimeQuery.isLoading ? (
							<div className="text-muted-foreground">Loading…</div>
						) : uptimeQuery.isError ? (
							<div className="text-muted-foreground">Failed to load.</div>
						) : uptimeQuery.data?.status ? (
							(() => {
								const s = uptimeQuery.data.status;
								const updated = s.updatedAtMs ? new Date(s.updatedAtMs) : null;
								const overall = s.overall;
								const color =
									overall === "up"
										? "text-emerald-700 dark:text-emerald-300"
										: overall === "degraded"
											? "text-amber-700 dark:text-amber-300"
											: overall === "down"
												? "text-rose-700 dark:text-rose-300"
												: "text-muted-foreground"
								return (
									<>
										<div className="flex items-center justify-between gap-3">
											<div className="text-muted-foreground">Overall</div>
											<div className={`font-semibold ${color}`}>{overall}</div>
										</div>
										<div className="flex items-center justify-between gap-3">
											<div className="text-muted-foreground">Updated</div>
											<div className="font-medium">
												{updated ? updated.toLocaleTimeString() : "-"}
											</div>
										</div>
										<div className="pt-1">
											<Button
												type="button"
												variant="outline"
												onClick={() => window.open("/uptime", "_blank")}
											>
												View public page
											</Button>
										</div>
									</>
								)
							})()
						) : (
							<div className="text-muted-foreground">No data.</div>
						)}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Active Users</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="space-y-1">
							<div className="text-xs text-muted-foreground">Users active in the last 24 hours</div>
							<div className="text-3xl font-semibold tabular-nums">
								{dashboardUsersQuery.isLoading ? "…" : dashboard ? dashboard.activeUsers24h.toLocaleString() : "-"}
							</div>
							{dashboard ? (
								<DeltaLine pct={dashboard.activeUsersDeltaPct} label="vs previous period" />
							) : null}
						</div>
						<Separator />
						<div className="space-y-1">
							<div className="text-sm font-medium">New Users</div>
							<div className="text-xs text-muted-foreground">Users who signed up in the last 24 hours</div>
							<div className="text-2xl font-semibold tabular-nums">
								{dashboardUsersQuery.isLoading ? "…" : dashboard ? dashboard.newUsers24h.toLocaleString() : "-"}
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="space-y-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle>Users</CardTitle>
							<Tabs defaultValue="total" className="w-auto">
								<TabsList>
									<TabsTrigger value="total">Total users</TabsTrigger>
									<TabsTrigger value="new">New users</TabsTrigger>
									<TabsTrigger value="retention">Retention</TabsTrigger>
								</TabsList>
								<TabsContent value="total" className="mt-3">
									<div className="text-xs text-muted-foreground">Total Users (Last 8 weeks)</div>
									<div className="mt-1 flex items-baseline justify-between gap-3">
										<div className="text-3xl font-semibold tabular-nums">
											{dashboardUsersQuery.isLoading
												? "…"
												: dashboard
													? formatCompact(dashboard.totalUsersNow)
													: "-"}
										</div>
										{dashboard ? (
											<DeltaLine pct={dashboard.totalUsersDeltaPct} label="from previous week" />
										) : null}
									</div>
									{dashboard ? (
										<SparkArea
											data={dashboard.seriesTotalUsersWeekly.map((p) => ({ ...p, v: p.value })) as any}
											valueKey="v"
										/>
									) : (
										<div className="h-24" />
									)}
								</TabsContent>
								<TabsContent value="new" className="mt-3">
									<div className="text-xs text-muted-foreground">New Users (Last 8 weeks)</div>
									<div className="mt-1 flex items-baseline justify-between gap-3">
										<div className="text-3xl font-semibold tabular-nums">
											{dashboardUsersQuery.isLoading
												? "…"
												: dashboard
													? formatCompact(
															dashboard.seriesNewUsersWeekly[dashboard.seriesNewUsersWeekly.length - 1]?.value ?? 0
														)
													: "-"}
										</div>
										{dashboard ? (
											<DeltaLine pct={dashboard.newUsersDeltaPctWoW} label="from previous week" />
										) : null}
									</div>
									{dashboard ? (
										<SparkArea
											data={dashboard.seriesNewUsersWeekly.map((p) => ({ ...p, v: p.value })) as any}
											valueKey="v"
										/>
									) : (
										<div className="h-24" />
									)}
								</TabsContent>
								<TabsContent value="retention" className="mt-3">
									<div className="text-xs text-muted-foreground">New-user retention (week +1)</div>
									<div className="mt-1 flex items-baseline justify-between gap-3">
										<div className="text-3xl font-semibold tabular-nums">
											{dashboardUsersQuery.isLoading
												? "…"
												: dashboard
													? (() => {
															const v =
																dashboard.seriesNewUserRetentionWeeklyPct[
																	dashboard.seriesNewUserRetentionWeeklyPct.length - 1
																]?.value
															return v == null ? "-" : "${v.toFixed(1)}%"
														})()
													: "-"}
										</div>
										{dashboard ? (
											<DeltaLine pct={dashboard.retentionDeltaPctWoW} label="from previous week" />
										) : null}
									</div>
									{dashboard ? (
										<SparkArea
											data={dashboard.seriesNewUserRetentionWeeklyPct.map((p) => ({ ...p, v: p.value })) as any}
											valueKey="v"
										/>
									) : (
										<div className="h-24" />
									)}
								</TabsContent>
							</Tabs>
						</div>
					</CardHeader>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Recent users</CardTitle>
					</CardHeader>
					<CardContent className="max-h-[260px] overflow-auto p-0">
						{recentUsersQuery.isLoading ? (
							<div className="px-6 py-4 text-sm text-muted-foreground">Loading…</div>
						) : recentUsersQuery.isError ? (
							<div className="px-6 py-4 text-sm text-muted-foreground">Failed to load.</div>
						) : recentUserRows.length === 0 ? (
							<div className="px-6 py-4 text-sm text-muted-foreground">No users in the last 24 hours.</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Time</TableHead>
										<TableHead>Email</TableHead>
										<TableHead>Location</TableHead>
										<TableHead>Device</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{recentUserRows.map((s) => {
										const started = new Date(s.startedAt);
										const time = started.toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
										})
										const email = s.userEmail ?? `${s.userId.slice(0, 8)}…`;
										const location = [s.country, s.colo].filter(Boolean).join(" / ") || "-";
										const device = formatUserDevice(s.userAgent);
										return (
											<TableRow
												key={s.userId}
												className="cursor-pointer"
												onClick={() =>
													navigate({
												to: "/ts_admin/turret/sessions/$sessionId",
														params: { sessionId: s.sessionId },
													})
												}
												title={started.toLocaleString()}
											>
												<TableCell className="px-6">{time}</TableCell>
												<TableCell className="max-w-[220px] truncate">
													<div className="truncate font-medium">{email}</div>
													{s.userEmail ? null : (
														<div className="truncate text-xs text-muted-foreground">(email off)</div>
													)}
												</TableCell>
												<TableCell>{location}</TableCell>
												<TableCell className="max-w-[160px] truncate" title={s.userAgent ?? ""}>
													{device}
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Last hour</CardTitle>
					</CardHeader>
					<CardContent className="space-y-1 text-sm">
						<div className="flex items-center justify-between gap-3">
							<div className="text-muted-foreground">Sessions</div>
							<div className="font-medium">
								{sessionsPreviewQuery.isLoading ? "…" : sessions.length}
							</div>
						</div>
						<div className="flex items-center justify-between gap-3">
							<div className="text-muted-foreground">Errors</div>
							<div className="font-medium">
								{sessionsPreviewQuery.isLoading ? "…" : errorCount}
							</div>
						</div>
						<div className="flex items-center justify-between gap-3">
							<div className="text-muted-foreground">Capture blocked</div>
							<div className="font-medium">
								{sessionsPreviewQuery.isLoading ? "…" : captureBlockedCount}
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Errors</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						<div className="space-y-1">
							<div className="text-xs text-muted-foreground">Open issues (last 24h)</div>
							<div className="text-3xl font-semibold tabular-nums">{openIssuesLabel}</div>
						</div>
						<Separator />
						<div className="flex items-center justify-between gap-3">
							<div className="text-muted-foreground">Error sessions (1h)</div>
							<div className="font-medium">{sessionsPreviewQuery.isLoading ? "…" : errorCount}</div>
						</div>
						<div className="flex flex-wrap gap-2 pt-1">
							<Button
								type="button"
								variant="outline"
								onClick={() =>
									navigate({
										to: "/ts_admin/turret/issues",
										search: { status: "open", preset: "24h", q: "", from: undefined, to: undefined, offset: 0, limit: 50 },
									})
								}
							>
								Open inbox
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() =>
									navigate({
										to: "/ts_admin/turret/sessions",
										search: { ...defaultSessionsSearch, hasError: true, offset: 0 },
									})
								}
							>
								View error sessions
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Recent sessions</CardTitle>
				</CardHeader>
				<CardContent className="space-y-2 text-sm">
					{sessionsPreviewQuery.isLoading ? (
						<div className="text-muted-foreground">Loading…</div>
					) : sessionsPreviewQuery.isError ? (
						<div className="text-muted-foreground">Failed to load sessions.</div>
					) : sessions.length === 0 ? (
						<div className="text-muted-foreground">No sessions in the last hour.</div>
					) : (
						<div className="divide-y rounded-md border">
							{sessions.map((s) => (
								<button
									key={s.sessionId}
									type="button"
									className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/20"
									onClick={() =>
										navigate({
											to: "/ts_admin/turret/sessions/$sessionId",
											params: { sessionId: s.sessionId },
										})
									}
								>
									<div className="min-w-0">
										<div className="truncate font-medium">
											{s.userEmail ?? s.userId}
										</div>
										<div className="truncate text-xs text-muted-foreground">
											{new Date(s.startedAt).toLocaleString()} · {s.sessionId.slice(0, 8)}…
										</div>
									</div>
									<div className="flex items-center gap-2">
										{s.captureBlocked ? <Badge variant="outline">blocked</Badge> : null}
										{s.hasError ? <Badge variant="destructive">error</Badge> : null}
									</div>
								</button>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</section>
	)
}

export { Route };
