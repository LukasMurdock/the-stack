import {
	turretListPageDefaults,
	turretBreadcrumbPageDefaults,
	turretSpanPageDefaults,
} from "@/contracts/turret-pagination";
import { isRecord } from "@/lib/isRecord";
import { z } from "zod";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { eventWithTime } from "@rrweb/types";

import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/ui/empty";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
	turretReplaySessionBreadcrumbsQueryOptions,
	turretReplaySessionChunksQueryOptions,
	turretReplaySessionErrorsQueryOptions,
	turretReplaySessionFeedbackQueryOptions,
	turretReplaySessionMetaQueryOptions,
	turretReplaySessionSpansQueryOptions,
} from "../../../../features/turret/queries";

import { RequestBreadcrumbRow } from "../../../../features/turret/session/RequestBreadcrumbRow";
import { loadReplayEvents } from "../../../../features/turret/session/replayLoader";
import {
	jumpReplayToTimestamp,
	type RrwebPlayerInstance,
} from "../../../../features/turret/session/replayPlayer";

function parseJsonObject(input: string | null): Record<string, unknown> | null {
	if (!input) return null;
	try {
		const parsed: unknown = JSON.parse(input);
		return z.record(z.string(), z.unknown()).parse(parsed);
	} catch {
		return null;
	}
}

const CLOUDFLARE_TRACES_URL =
	"https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/traces";

const Route = createFileRoute("/ts_admin/turret/replay-sessions/$sessionId")({
	component: TurretReplaySessionPage,
});

function TurretReplaySessionPage() {
	const navigate = useNavigate();
	const { sessionId } = Route.useParams();
	const metaQuery = useQuery(turretReplaySessionMetaQueryOptions(sessionId));
	const chunksQuery = useQuery(
		turretReplaySessionChunksQueryOptions(sessionId)
	);
	const errorsQuery = useQuery(
		turretReplaySessionErrorsQueryOptions(sessionId)
	);
	const feedbackQuery = useQuery(
		turretReplaySessionFeedbackQueryOptions(sessionId, {
			limit: turretListPageDefaults.limit,
			offset: 0,
		})
	);
	const [breadcrumbsOffset, setBreadcrumbsOffset] = useState(0);
	const breadcrumbsLimit = turretBreadcrumbPageDefaults.limit;
	const breadcrumbsQuery = useQuery(
		turretReplaySessionBreadcrumbsQueryOptions(sessionId, {
			limit: breadcrumbsLimit,
			offset: breadcrumbsOffset,
		})
	);
	const sessionSpansQuery = useQuery(
		turretReplaySessionSpansQueryOptions(sessionId, {
			limit: turretSpanPageDefaults.limit,
			offset: 0,
		})
	);

	const playerHostRef = useRef<HTMLDivElement | null>(null);
	const playerRef = useRef<RrwebPlayerInstance | null>(null);

	const sortedSeqs = useMemo(() => {
		const chunks = chunksQuery.data?.chunks ?? [];
		return chunks
			.map((c) => c.seq)
			.filter((s) => Number.isFinite(s))
			.sort((a, b) => a - b);
	}, [chunksQuery.data?.chunks]);

	const [replayStatus, setReplayStatus] = useState<
		| { state: "idle" }
		| { state: "loading"; loaded: number; total: number }
		| {
				state: "ready";
				sessionId: string;
				seqs: number[];
				events: eventWithTime[];
		  }
		| { state: "error"; message: string }
	>({ state: "idle" });

	// A previous session or chunk set cannot enable controls before its effect cleans up.
	const replayReady =
		replayStatus.state === "ready" &&
		replayStatus.sessionId === sessionId &&
		replayStatus.seqs === sortedSeqs;

	type ConsoleItem = {
		timestamp: number;
		level: string;
		payload: unknown[];
		trace: string[];
	};

	const consoleItems = useMemo(() => {
		if (!replayReady || replayStatus.state !== "ready") return [];
		const items: ConsoleItem[] = [];
		for (const ev of replayStatus.events) {
			// Inspect plugin payloads structurally without loading rrweb at runtime.
			const data: unknown = "data" in ev ? ev.data : undefined;
			if (
				!data ||
				typeof data !== "object" ||
				!("plugin" in data) ||
				data.plugin !== "rrweb/console@1" ||
				!("payload" in data)
			)
				continue;
			const candidate: unknown = data.payload;
			if (!isRecord(candidate)) continue;
			const logData = candidate;

			const ts = typeof ev.timestamp === "number" ? ev.timestamp : NaN;
			if (!Number.isFinite(ts)) continue;

			const payload = Array.isArray(logData.payload)
				? logData.payload.map((s: unknown) => {
						if (typeof s === "string") {
							try {
								return JSON.parse(s);
							} catch {
								return s;
							}
						}
						return s;
					})
				: [];

			items.push({
				timestamp: ts,
				level: String(logData.level ?? "log"),
				payload,
				trace: Array.isArray(logData.trace)
					? logData.trace.map(String)
					: [],
			});
		}

		items.sort((a, b) => a.timestamp - b.timestamp);
		return items;
	}, [replayStatus, replayReady]);

	useEffect(() => {
		const controller = new AbortController();
		const currentHost = playerHostRef.current;
		if (!currentHost) return;
		const host = currentHost;
		let active = true;
		let player: RrwebPlayerInstance | null = null;

		function clearPlayer() {
			const previous = player;
			player = null;
			if (playerRef.current === previous) playerRef.current = null;
			try {
				previous?.$destroy?.();
			} catch (error) {
				if (import.meta.env.DEV)
					console.warn("Replay player cleanup failed", error);
			} finally {
				host.replaceChildren();
			}
		}

		async function loadAndMount() {
			// Empty sessions never load the playback library.
			if (sortedSeqs.length === 0) {
				setReplayStatus({ state: "idle" });
				return;
			}
			setReplayStatus({
				state: "loading",
				loaded: 0,
				total: sortedSeqs.length,
			});
			await import("rrweb-player/dist/style.css");
			const { default: ReplayPlayer } = await import("rrweb-player");
			if (!active || controller.signal.aborted) return;
			const events = await loadReplayEvents({
				sessionId,
				seqs: sortedSeqs,
				signal: controller.signal,
				onProgress: (loaded, total) => {
					if (active && !controller.signal.aborted)
						setReplayStatus({ state: "loading", loaded, total });
				},
			});
			if (!active || controller.signal.aborted) return;
			player = new ReplayPlayer({
				target: host,
				props: { events, autoPlay: false, showController: true },
			});
			playerRef.current = player;
			setReplayStatus({
				state: "ready",
				sessionId,
				seqs: sortedSeqs,
				events,
			});
		}

		void loadAndMount().catch((error: unknown) => {
			if (!active || controller.signal.aborted) return;
			clearPlayer();
			setReplayStatus({
				state: "error",
				message:
					error instanceof Error
						? error.message
						: "Failed to load replay",
			});
		});
		return () => {
			active = false;
			controller.abort();
			clearPlayer();
		};
	}, [sessionId, sortedSeqs]);

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						Replay session
					</h1>
					<p className="text-sm text-muted-foreground">{sessionId}</p>
				</div>
				<div className="flex items-center gap-2">
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
							navigate({
								to: "/ts_admin/turret/issues",
								search: {},
							})
						}
					>
						Issues
					</Button>
				</div>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Replay</CardTitle>
				</CardHeader>
				<CardContent>
					{replayStatus.state === "idle" &&
					sortedSeqs.length === 0 ? (
						<>
							<Empty>
								<EmptyHeader>
									<EmptyTitle>No replay data yet</EmptyTitle>
									<EmptyDescription>
										This replay session has no chunks
										indexed in Turret.
									</EmptyDescription>
								</EmptyHeader>
								<EmptyContent />
							</Empty>
						</>
					) : (
						<div className="space-y-2">
							{replayStatus.state === "error" ? (
								<div className="text-sm text-destructive">
									Failed to load replay:{" "}
									{replayStatus.message}
								</div>
							) : replayStatus.state === "loading" ? (
								<div className="text-sm text-muted-foreground">
									Loading replay… {replayStatus.loaded}/
									{replayStatus.total}
								</div>
							) : replayStatus.state === "ready" &&
							  replayReady ? (
								<div className="text-xs text-muted-foreground">
									Loaded {replayStatus.events.length} events
								</div>
							) : null}
						</div>
					)}
					<div
						ref={playerHostRef}
						className={
							sortedSeqs.length === 0
								? "hidden"
								: "mt-2 min-h-[420px] overflow-hidden rounded-md border bg-background"
						}
					/>
				</CardContent>
			</Card>

			<Tabs defaultValue="meta" className="flex-col">
				<TabsList>
					<TabsTrigger value="meta">Metadata</TabsTrigger>
					<TabsTrigger value="errors">Errors</TabsTrigger>
					<TabsTrigger value="feedback">Feedback</TabsTrigger>
					<TabsTrigger value="console">Console</TabsTrigger>
					<TabsTrigger value="issues">Issues</TabsTrigger>
					<TabsTrigger value="perf">Performance</TabsTrigger>
				</TabsList>

				<TabsContent value="meta" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Replay session metadata</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2 text-sm">
							{metaQuery.isLoading ? (
								<div className="text-muted-foreground">
									Loading…
								</div>
							) : metaQuery.isError ? (
								<div className="text-destructive">
									Failed to load metadata
								</div>
							) : !metaQuery.data ? (
								<div className="text-muted-foreground">
									No data
								</div>
							) : (
								<>
									<div>
										<span className="text-muted-foreground">
											Started:
										</span>{" "}
										{new Date(
											metaQuery.data.session.startedAt
										).toLocaleString()}
									</div>
									<div>
										<span className="text-muted-foreground">
											URL:
										</span>{" "}
										{metaQuery.data.session.lastUrl ??
											metaQuery.data.session.initialUrl ??
											"-"}
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<div>
											<span className="text-muted-foreground">
												Journey:
											</span>{" "}
											{metaQuery.data.session.journeyId ??
												"-"}
										</div>
									</div>
									<div>
										<span className="text-muted-foreground">
											Chunks:
										</span>{" "}
										{metaQuery.data.session.chunkCount}
									</div>
									<div>
										<span className="text-muted-foreground">
											Errors:
										</span>{" "}
										{metaQuery.data.session.hasError
											? "yes"
											: "no"}
									</div>
									<div>
										<span className="text-muted-foreground">
											Location:
										</span>{" "}
										{[
											metaQuery.data.session.country,
											metaQuery.data.session.colo,
										]
											.filter(Boolean)
											.join(" /") || "-"}
									</div>
									<div className="pt-2 text-muted-foreground">
										Chunk index loaded:{" "}
										{chunksQuery.data?.chunks.length ?? 0}
									</div>
								</>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="errors" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Errors</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2">
							{errorsQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading…
								</div>
							) : errorsQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load errors
								</div>
							) : !errorsQuery.data ||
							  errorsQuery.data.errors.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No errors for this replay session.
								</div>
							) : (
								<div className="space-y-2">
									{errorsQuery.data.errors.map((e) => {
										const ts = new Date(e.ts).getTime();
										const expiresLabel = e.expiresAt
											? new Date(
													e.expiresAt
												).toLocaleString()
											: "legacy (no ttl)";
										const extra = parseJsonObject(
											e.extraJson
										);
										const rayId =
											typeof extra?.ray_id === "string"
												? extra.ray_id
												: null;
										return (
											<div
												key={e.id}
												className="rounded-md border bg-card p-3"
											>
												<div className="flex flex-wrap items-start justify-between gap-3">
													<div className="min-w-0">
														<div className="text-sm font-medium">
															{e.message ??
																"Error"}
														</div>
														<div className="mt-1 text-xs text-muted-foreground">
															{e.source} ·{" "}
															{new Date(
																ts
															).toLocaleString()}
														</div>
														<div className="mt-1 text-xs text-muted-foreground">
															Expires:{" "}
															{expiresLabel}
															{e.fingerprint
																? " · fp ${e.fingerprint}"
																: ""}
														</div>
														{rayId ? (
															<div className="mt-1 text-xs text-muted-foreground">
																ray {rayId}
															</div>
														) : null}
													</div>
													<div className="flex items-center gap-2">
														{rayId ? (
															<>
																<button
																	type="button"
																	className="rounded-md border px-2.5 py-1 text-xs"
																	onClick={() => {
																		try {
																			void navigator.clipboard.writeText(
																				rayId
																			);
																		} catch {
																			// ignore
																		}
																	}}
																>
																	Copy ray
																</button>
																<a
																	href={
																		CLOUDFLARE_TRACES_URL
																	}
																	target="_blank"
																	rel="noreferrer"
																	className="rounded-md border px-2.5 py-1 text-xs"
																	title="Open Cloudflare Traces (search by ray id)"
																>
																	Trace
																</a>
															</>
														) : null}
														<button
															type="button"
															className="rounded-md border px-2.5 py-1 text-xs"
															disabled={
																!replayReady
															}
															onClick={() =>
																jumpReplayToTimestamp(
																	playerRef.current,
																	ts
																)
															}
														>
															Jump
														</button>
													</div>
												</div>
												{e.stack ? (
													<details className="mt-3 text-xs">
														<summary className="cursor-pointer select-none text-muted-foreground">
															Stack
														</summary>
														<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-snug">
															{e.stack}
														</pre>
													</details>
												) : null}
											</div>
										);
									})}
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="feedback" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Feedback</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2">
							{feedbackQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading…
								</div>
							) : feedbackQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load feedback
								</div>
							) : !feedbackQuery.data ||
							  feedbackQuery.data.feedback.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No feedback for this replay session.
								</div>
							) : (
								<div className="space-y-2">
									{feedbackQuery.data.feedback.map((f) => (
										<div
											key={f.id}
											className="rounded-md border bg-card p-3"
										>
											<div className="flex flex-wrap items-start justify-between gap-3">
												<div className="min-w-0">
													<div className="text-sm font-medium">
														{f.message}
													</div>
													<div className="mt-1 text-xs text-muted-foreground">
														{f.kind} · {f.status} ·{" "}
														{new Date(
															f.ts
														).toLocaleString()}
													</div>
													{f.contact ? (
														<div className="mt-1 text-xs text-muted-foreground">
															contact: {f.contact}
														</div>
													) : null}
													{f.url ? (
														<div
															className="mt-1 truncate text-xs text-muted-foreground"
															title={f.url}
														>
															{f.url}
														</div>
													) : null}
												</div>
												<div className="flex items-center gap-2">
													<button
														type="button"
														className="rounded-md border px-2.5 py-1 text-xs"
														disabled={!replayReady}
														onClick={() =>
															jumpReplayToTimestamp(
																playerRef.current,
																f.ts
															)
														}
													>
														Jump
													</button>
													<Button
														type="button"
														variant="outline"
														onClick={() =>
															navigate({
																to: "/ts_admin/turret/feedback",
															})
														}
													>
														All feedback
													</Button>
												</div>
											</div>
										</div>
									))}
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="console" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Console</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2">
							{!replayReady ? (
								<div className="text-sm text-muted-foreground">
									Load the replay to view console output.
								</div>
							) : consoleItems.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No console entries found.
								</div>
							) : (
								<div className="space-y-2">
									{consoleItems.map((item, idx) => {
										const ts = item.timestamp;
										return (
											<div
												key={`${ts}-${idx}`}
												className="rounded-md border bg-card p-3"
											>
												<div className="flex flex-wrap items-start justify-between gap-3">
													<div className="min-w-0">
														<div className="text-sm font-medium">
															<span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
																{item.level}
															</span>
															{item.payload
																.map((p) => {
																	if (
																		typeof p ===
																		"string"
																	)
																		return p;
																	try {
																		return JSON.stringify(
																			p
																		);
																	} catch {
																		return String(
																			p
																		);
																	}
																})
																.join(" ")}
														</div>
														<div className="mt-1 text-xs text-muted-foreground">
															{new Date(
																ts
															).toLocaleString()}
														</div>
													</div>
													<div className="flex items-center gap-2">
														<details className="text-xs">
															<summary className="cursor-pointer select-none text-muted-foreground">
																Trace
															</summary>
															{item.trace.length >
															0 ? (
																<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug">
																	{item.trace.join(
																		"\n"
																	)}
																</pre>
															) : (
																<div className="mt-2 text-muted-foreground">
																	No trace
																</div>
															)}
														</details>
														<button
															type="button"
															className="rounded-md border px-2.5 py-1 text-xs"
															disabled={
																!replayReady
															}
															onClick={() =>
																jumpReplayToTimestamp(
																	playerRef.current,
																	ts
																)
															}
														>
															Jump
														</button>
													</div>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="issues" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Issues</CardTitle>
						</CardHeader>
						<CardContent>
							<Empty>
								<EmptyHeader>
									<EmptyTitle>Coming next</EmptyTitle>
									<EmptyDescription>
										Issue grouping, fingerprints, and trend
										charts.
									</EmptyDescription>
								</EmptyHeader>
								<EmptyContent />
							</Empty>
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="perf" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Performance</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2">
							{breadcrumbsQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading…
								</div>
							) : breadcrumbsQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load breadcrumbs
								</div>
							) : !breadcrumbsQuery.data ||
							  breadcrumbsQuery.data.breadcrumbs.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No requests recorded for this replay
									session.
								</div>
							) : sessionSpansQuery.isError ? (
								<div className="text-sm text-destructive">
									Failed to load spans
								</div>
							) : sessionSpansQuery.isLoading ? (
								<div className="text-sm text-muted-foreground">
									Loading spans…
								</div>
							) : (
								<div className="space-y-2">
									{breadcrumbsQuery.data.breadcrumbs.map(
										(b) => {
											const ts = new Date(b.ts).getTime();
											const spans =
												sessionSpansQuery.data
													?.spansByRequestId[
													b.requestId
												] ?? [];
											return (
												<RequestBreadcrumbRow
													key={b.id}
													breadcrumb={b}
													ts={ts}
													spans={spans}
													replayReady={replayReady}
													playerRef={playerRef}
												/>
											);
										}
									)}
									<div className="flex items-center justify-between pt-2">
										<div className="text-xs text-muted-foreground">
											Offset {breadcrumbsOffset} · Showing{" "}
											{
												breadcrumbsQuery.data
													.breadcrumbs.length
											}{" "}
											· Limit {breadcrumbsLimit}
											{sessionSpansQuery.data?.hasMore
												? " · spans truncated"
												: ""}
										</div>
										<div className="flex items-center gap-2">
											<button
												type="button"
												className="rounded-md border px-2.5 py-1 text-xs"
												disabled={
													breadcrumbsOffset === 0
												}
												onClick={() =>
													setBreadcrumbsOffset(
														Math.max(
															0,
															breadcrumbsOffset -
																breadcrumbsLimit
														)
													)
												}
											>
												Prev
											</button>
											<button
												type="button"
												className="rounded-md border px-2.5 py-1 text-xs"
												disabled={
													breadcrumbsQuery.data
														.breadcrumbs.length <
													breadcrumbsLimit
												}
												onClick={() =>
													setBreadcrumbsOffset(
														breadcrumbsOffset +
															breadcrumbsLimit
													)
												}
											>
												Next
											</button>
										</div>
									</div>
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>
			</Tabs>
		</section>
	);
}

export { Route };
