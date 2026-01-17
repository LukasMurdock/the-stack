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
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../lib/authClient";
import {
	turretFeaturesMutation,
	turretFeaturesQueryOptions,
	turretHealthQueryOptions,
	turretSessionsQueryOptions,
} from "../../queries/turretQueries";

type RangePreset = "15m" | "1h" | "24h" | "custom";


const Route = createFileRoute("/turret/")({
	validateSearch: (s: Record<string, unknown>) => {
		return {
			q: typeof s.q === "string" ? s.q : "",
			hasError: s.hasError === "1",
			grouped:
				s.grouped === true || s.grouped === "true" || s.grouped === "1",
			preset:
				s.preset === "15m" || s.preset === "1h" || s.preset === "24h" || s.preset === "custom"
					? (s.preset as RangePreset)
					: ("1h" as RangePreset),
			from: typeof s.from === "string" ? Number(s.from) : undefined,
			to: typeof s.to === "string" ? Number(s.to) : undefined,
			offset: typeof s.offset === "string" ? Number(s.offset) : 0,
			limit: typeof s.limit === "string" ? Number(s.limit) : 50,
		};
	},
	component: TurretSessionsPage,
});

function presetToRange(preset: RangePreset): { from?: number; to?: number } {
	const now = Date.now();
	switch (preset) {
		case "15m":
			return { from: now - 15 * 60 * 1000, to: now };
		case "1h":
			return { from: now - 60 * 60 * 1000, to: now };
		case "24h":
			return { from: now - 24 * 60 * 60 * 1000, to: now };
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

type SessionRow = {
	sessionId: string;
	userId: string;
	userEmail: string | null;
	workerVersionTag: string | null;
	startedAt: string;
	captureBlocked: boolean;
	captureBlockedReason: string | null;
	initialUrl: string | null;
	lastUrl: string | null;
	hasError: boolean;
	chunkCount: number;
};

function GroupedSessions(props: {
	sessions: SessionRow[];
	onOpenSession: (id: string) => void;
}) {
	const groups = useMemo(() => {
		const map = new Map<string, any[]>();
		for (const s of props.sessions) {
			const key = s.userId;
			const list = map.get(key) ?? [];
			list.push(s);
			map.set(key, list);
		}
		// newest-first inside each group
		for (const list of map.values()) {
			list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
		}
		return Array.from(map.entries()).sort((a, b) => {
			const aTs = new Date(a[1][0]?.startedAt ?? 0).getTime();
			const bTs = new Date(b[1][0]?.startedAt ?? 0).getTime();
			return bTs - aTs;
		});
	}, [props.sessions]);

	return (
		<div className="rounded-md border">
			{groups.length === 0 ? (
				<div className="p-4 text-sm text-muted-foreground">No sessions</div>
			) : (
				<div className="divide-y">
					{groups.map(([userId, sessions]) => {
						const display = sessions[0]?.userEmail ?? userId;
						return (
							<details key={userId} className="group">
								<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
									<div className="min-w-0">
										<div className="truncate font-medium">{display}</div>
										<div className="truncate text-xs text-muted-foreground">{userId}</div>
									</div>
									<div className="flex items-center gap-2">
										{sessions.some((s) => s.captureBlocked) ? (
											<Badge variant="outline">capture blocked</Badge>
										) : null}
										{sessions.some((s) => s.hasError) ? (
											<Badge variant="destructive">error</Badge>
										) : null}
										<div className="shrink-0 text-xs text-muted-foreground">
											{sessions.length} session{sessions.length === 1 ? "" : "s"}
										</div>
									</div>
								</summary>
								<div className="border-t bg-muted/20">
									<table className="w-full text-sm">
										<thead>
											<tr className="text-muted-foreground">
												<th className="px-4 py-2 text-left font-medium">Started</th>
												<th className="px-4 py-2 text-left font-medium">Build tag</th>
												<th className="px-4 py-2 text-left font-medium">URL</th>
												<th className="px-4 py-2 text-left font-medium">Errors</th>
												<th className="px-4 py-2 text-left font-medium">Chunks</th>
											</tr>
										</thead>
										<tbody>
											{sessions.map((s) => {
												const started = new Date(s.startedAt);
												return (
													<tr
														key={s.sessionId}
														className="cursor-pointer border-t hover:bg-background"
														onClick={() => props.onOpenSession(s.sessionId)}
													>
														<td className="px-4 py-2">
															<div className="font-medium">{started.toLocaleString()}</div>
															<div className="text-xs text-muted-foreground">{s.sessionId.slice(0, 8)}…</div>
														</td>
														<td className="max-w-[160px] truncate px-4 py-2 text-xs">
															{s.workerVersionTag ?? "-"}
														</td>
														<td className="max-w-[520px] truncate px-4 py-2">
															{s.lastUrl ?? s.initialUrl ?? "(unknown)"}
														</td>
														<td className="px-4 py-2">
															{s.hasError ? (
																<span className="inline-flex rounded bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">yes</span>
															) : (
																<span className="inline-flex rounded bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">no</span>
															)}
														</td>
														<td className="px-4 py-2">{s.chunkCount}</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							</details>
						);
					})}
				</div>
			)}
		</div>
	);
}

function TurretSessionsPage() {
	const navigate = useNavigate();
	const sessionQuery = authClient.useSession();
	const search = Route.useSearch();

	const queryClient = useQueryClient();
	const healthQuery = useQuery(turretHealthQueryOptions);
	const featuresQuery = useQuery(turretFeaturesQueryOptions);
	const featuresMutation = useMutation({
		mutationFn: turretFeaturesMutation,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["turret", "features"] });
		},
	});

	// Redirect behavior: if we know user isn't signed in.
	if (sessionQuery.data && !sessionQuery.data.user) {
		navigate({ to: "/login" });
	}

	const range = useMemo(() => {
		if (search.preset === "custom") {
			return { from: search.from, to: search.to };
		}
		return presetToRange(search.preset);
	}, [search.from, search.preset, search.to]);

	const sessionsQuery = useQuery(
		turretSessionsQueryOptions({
			hasError: search.hasError,
			q: search.q || undefined,
			from: range.from,
			to: range.to,
			limit: search.limit,
			offset: search.offset,
		})
	);

	const [qInput, setQInput] = useState(search.q);

	function applyFilters() {
		navigate({
			to: "/turret",
			search: {
				...search,
				q: qInput,
				offset: 0,
			},
		});
	}

	function setPreset(preset: RangePreset) {
		const next = preset === "custom" ? { from: search.from, to: search.to } : presetToRange(preset);
		navigate({
			to: "/turret",
			search: {
				...search,
				preset,
				from: next.from,
				to: next.to,
				offset: 0,
			},
		});
	}

	function setHasError(hasError: boolean) {
		navigate({
			to: "/turret",
			search: {
				...search,
				hasError,
				offset: 0,
			},
		});
	}

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Turret</h1>
				<p className="text-sm text-muted-foreground">
					Internal observability console. Session replay first, errors next.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Filters</CardTitle>
					<CardAction>
						<div className="flex items-center gap-2">
							<div className="text-xs text-muted-foreground">Store emails</div>
							<Switch
								checked={featuresQuery.data?.features.storeUserEmail ?? false}
								onCheckedChange={(checked) =>
									featuresMutation.mutate({ storeUserEmail: checked })
								}
								disabled={featuresQuery.isLoading || featuresMutation.isPending}
							/>
						</div>
					</CardAction>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant={search.preset === "15m" ? "default" : "outline"}
							onClick={() => setPreset("15m")}
							type="button"
						>
							Last 15m
						</Button>
						<Button
							variant={search.preset === "1h" ? "default" : "outline"}
							onClick={() => setPreset("1h")}
							type="button"
						>
							Last 1h
						</Button>
						<Button
							variant={search.preset === "24h" ? "default" : "outline"}
							onClick={() => setPreset("24h")}
							type="button"
						>
							Last 24h
						</Button>
						<Button
							variant={search.preset === "custom" ? "default" : "outline"}
							onClick={() => setPreset("custom")}
							type="button"
						>
							Custom
						</Button>

						<Button
							variant={search.hasError ? "default" : "outline"}
							onClick={() => setHasError(!search.hasError)}
							type="button"
						>
							Has Error
						</Button>
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
										navigate({
											to: "/turret",
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
										const nextTo = fromLocalDatetimeValue(e.target.value);
										navigate({
											to: "/turret",
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

					<div className="flex flex-wrap items-center gap-2">
						<div className="flex min-w-[240px] flex-1 items-center gap-2">
							<Input
								placeholder="URL contains…"
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

						<div className="text-sm text-muted-foreground">
							{healthQuery.isLoading
								? "Checking access…"
								: healthQuery.isError
									? "Access denied or not signed in"
									: "Admin access confirmed"}
						</div>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Sessions</CardTitle>
					<CardAction>
						<div className="flex items-center gap-2">
							<div className="text-xs text-muted-foreground">Grouped</div>
							<Switch
								checked={search.grouped}
								onCheckedChange={(checked) =>
									navigate({
										to: "/turret",
										search: {
											...search,
											grouped: checked,
											offset: 0,
										},
									})
								}
							/>
						</div>
					</CardAction>
				</CardHeader>
				<CardContent>
					{sessionsQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">Loading…</div>
					) : sessionsQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load sessions.
						</div>
					) : (sessionsQuery.data?.sessions.length ?? 0) === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No sessions found</EmptyTitle>
								<EmptyDescription>
									Try widening your time range or clearing filters.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent />
						</Empty>
					) : search.grouped ? (
						<GroupedSessions
							sessions={sessionsQuery.data?.sessions ?? []}
							onOpenSession={(id: string) =>
								navigate({
									to: "/turret/sessions/$sessionId",
									params: { sessionId: id },
								})
							}
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
								<TableHead>Started</TableHead>
								<TableHead>User</TableHead>
								<TableHead>Build tag</TableHead>
								<TableHead>URL</TableHead>
								<TableHead>Errors</TableHead>
								<TableHead>Chunks</TableHead>
								<TableHead>Location</TableHead>

								</TableRow>
							</TableHeader>
							<TableBody>
								{(sessionsQuery.data?.sessions ?? []).map((s) => {
									const started = new Date(s.startedAt);
									return (
										<TableRow
											key={s.sessionId}
											className="cursor-pointer"
											onClick={() =>
												navigate({
													to: "/turret/sessions/$sessionId",
													params: { sessionId: s.sessionId },
												})
											}
										>
											<TableCell>
												<div className="font-medium">
													{started.toLocaleString()}
												</div>
												<div className="text-xs text-muted-foreground">
													{s.sessionId.slice(0, 8)}…
												</div>
											</TableCell>
										<TableCell className="max-w-[220px]">
											<div className="truncate font-medium">
												{s.userEmail ?? s.userId}
											</div>
											{s.userEmail ? (
												<div className="truncate text-xs text-muted-foreground">
													{s.userId}
												</div>
											) : (
												<div className="truncate text-xs text-muted-foreground">
													(email storage disabled)
												</div>
											)}
										</TableCell>
										<TableCell className="max-w-[160px] truncate text-xs">
											{s.workerVersionTag ?? "-"}
										</TableCell>
										<TableCell className="max-w-[360px] truncate">
											{s.lastUrl ?? s.initialUrl ?? "(unknown)"}
										</TableCell>

											<TableCell>
												{s.hasError ? (
													<Badge variant="destructive">yes</Badge>
												) : (
													<Badge variant="secondary">no</Badge>
												)}
											</TableCell>
											<TableCell>{s.chunkCount}</TableCell>
											<TableCell>
												<span className="text-sm">
													{[s.country, s.colo].filter(Boolean).join(" /") || "-"}
												</span>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}

					{sessionsQuery.data ? (
						<div className="mt-4 flex items-center justify-between gap-3">
							<Button
								variant="outline"
								disabled={search.offset <= 0}
								onClick={() =>
									navigate({
										to: "/turret",
										search: {
											...search,
											offset: Math.max(0, search.offset - search.limit),
										},
									})
								}
								type="button"
							>
								Prev
							</Button>
							<div className="text-sm text-muted-foreground">
								Showing {search.offset + 1}–{search.offset + sessionsQuery.data.sessions.length}
							</div>
							<Button
								variant="outline"
								disabled={sessionsQuery.data.sessions.length < search.limit}
								onClick={() =>
									navigate({
										to: "/turret",
										search: {
											...search,
											offset: search.offset + search.limit,
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

			<div className="text-xs text-muted-foreground">
				Hidden URL: bookmark this page if you use it often.
			</div>
		</section>
	);
}

export { Route };
