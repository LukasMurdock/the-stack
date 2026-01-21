import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer } from "@/components/ui/chart";
import { Area, AreaChart, Tooltip, XAxis, YAxis } from "recharts";

import {
	turretFeaturesQueryOptions,
	turretHealthQueryOptions,
	turretSessionsQueryOptions,
	turretDashboardUsersQueryOptions,
} from "../../queries/turretQueries";

const Route = createFileRoute("/turret/")({
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

	const healthQuery = useQuery(turretHealthQueryOptions);
	const featuresQuery = useQuery(turretFeaturesQueryOptions);

	// Anchor time for this mount so the queryKey stays stable.
	const [now] = useState(() => Date.now());
	const dashboardUsersQuery = useQuery(turretDashboardUsersQueryOptions({ to: now }));
	const sessionsPreviewQuery = useQuery(
		turretSessionsQueryOptions({
			from: now - 60 * 60 * 1000,
			to: now,
			limit: 10,
			offset: 0,
		})
	);

	const sessions = sessionsPreviewQuery.data?.sessions ?? [];
	const errorCount = sessions.filter((s) => s.hasError).length;
	const captureBlockedCount = sessions.filter((s) => s.captureBlocked).length;

	const dashboard = dashboardUsersQuery.data;

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
		);
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
		);
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
								to: "/turret/sessions",
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
																]?.value;
															return v == null ? "-" : `${v.toFixed(1)}%`;
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
						<CardTitle>Access</CardTitle>
					</CardHeader>
					<CardContent className="text-sm">
						{healthQuery.isLoading ? (
							<div className="text-muted-foreground">Checking…</div>
						) : healthQuery.isError ? (
							<div className="text-muted-foreground">Denied or not signed in</div>
						) : (
							<div className="flex items-center gap-2">
								<Badge variant="secondary">ok</Badge>
								<div className="text-muted-foreground">Admin access confirmed</div>
							</div>
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
						<CardTitle>Privacy</CardTitle>
					</CardHeader>
					<CardContent className="text-sm">
						<div className="flex items-center justify-between gap-3">
							<div className="text-muted-foreground">Store emails</div>
							<div className="font-medium">
								{featuresQuery.isLoading
									? "…"
									: featuresQuery.data?.features.storeUserEmail
										? "enabled"
										: "disabled"}
							</div>
						</div>
						<div className="mt-2 text-xs text-muted-foreground">
							Change this in Sessions (Filters).
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
											to: "/turret/sessions/$sessionId",
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
	);
}

export { Route };
