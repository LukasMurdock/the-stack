import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import {
	turretFeaturesQueryOptions,
	turretHealthQueryOptions,
	turretSessionsQueryOptions,
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
