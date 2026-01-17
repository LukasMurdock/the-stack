import "rrweb-player/dist/style.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import rrwebPlayer from "rrweb-player";
import { EventType, IncrementalSource } from "rrweb";
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
import {
	getSessionChunk,
	type TurretReplayChunkPayload,
	type TurretRequestBreadcrumb,
} from "../../../lib/turretApi";
import {
	turretRequestSpansQueryOptions,
	turretSessionBreadcrumbsQueryOptions,
	turretSessionChunksQueryOptions,
	turretSessionErrorsQueryOptions,
	turretSessionMetaQueryOptions,
} from "../../../queries/turretQueries";

const Route = createFileRoute("/turret/sessions/$sessionId")({
	component: TurretSessionPage,
});

function RequestBreadcrumbRow(props: {
	breadcrumb: TurretRequestBreadcrumb;
	ts: number;
	replayReady: boolean;
	playerRef: React.RefObject<rrwebPlayer | null>;
}) {
	const spansQuery = useQuery(turretRequestSpansQueryOptions(props.breadcrumb.requestId));
	const b = props.breadcrumb;

	return (
		<div className="rounded-md border bg-card p-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-sm font-medium">
						{b.method} {b.path}
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						{b.status} · {b.durationMs}ms · d1 {b.d1QueriesCount}q/{b.d1QueriesTimeMs}ms
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						{new Date(props.ts).toLocaleString()} · {b.requestId}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<details className="text-xs">
						<summary className="cursor-pointer select-none text-muted-foreground">D1 spans</summary>
						{spansQuery.isLoading ? (
							<div className="mt-2 text-muted-foreground">Loading…</div>
						) : spansQuery.isError ? (
							<div className="mt-2 text-destructive">Failed to load spans</div>
						) : !spansQuery.data || spansQuery.data.spans.length === 0 ? (
							<div className="mt-2 text-muted-foreground">No spans</div>
						) : (
							<div className="mt-2 space-y-2">
								{spansQuery.data.spans.map((s) => (
									<div key={s.id} className="rounded-md border bg-background p-2">
										<div className="text-xs">
											{s.kind} · {s.db} · {s.durationMs}ms
										</div>
										{s.sqlShape ? (
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
												{s.sqlShape}
											</pre>
										) : null}
										{s.errorMessage ? (
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] text-destructive">
												{s.errorMessage}
											</pre>
										) : null}
									</div>
								))}
							</div>
						)}
					</details>
					<button
						type="button"
						className="rounded-md border px-2.5 py-1 text-xs"
						disabled={!props.replayReady}
						onClick={() => {
							const player = props.playerRef.current;
							if (!player) return;
							const meta = player.getMetaData?.();
							if (!meta || typeof meta.startTime !== "number") return;
							const startTime = meta.startTime;
							const totalTime = typeof meta.totalTime === "number" ? meta.totalTime : Infinity;
							const offset = Math.max(0, Math.min(totalTime, props.ts - startTime));
							player.goto(offset, false);
						}}
					>
						Jump
					</button>
				</div>
			</div>
		</div>
	);
}

function TurretSessionPage() {
	const { sessionId } = Route.useParams();
	const metaQuery = useQuery(turretSessionMetaQueryOptions(sessionId));
	const chunksQuery = useQuery(turretSessionChunksQueryOptions(sessionId));
	const errorsQuery = useQuery(turretSessionErrorsQueryOptions(sessionId));
	const [breadcrumbsOffset, setBreadcrumbsOffset] = useState(0);
	const breadcrumbsLimit = 200;
	const breadcrumbsQuery = useQuery(
		turretSessionBreadcrumbsQueryOptions(sessionId, {
			limit: breadcrumbsLimit,
			offset: breadcrumbsOffset,
		})
	);

	const playerHostRef = useRef<HTMLDivElement | null>(null);
	const playerRef = useRef<rrwebPlayer | null>(null);

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
		| { state: "ready"; totalEvents: number }
		| { state: "error"; message: string }
	>({ state: "idle" });

	const [replayEvents, setReplayEvents] = useState<eventWithTime[]>([]);

	type ConsoleItem = {
		timestamp: number;
		level: string;
		payload: unknown[];
		trace: string[];
	};

	const consoleItems = useMemo(() => {
		const items: ConsoleItem[] = [];
		for (const ev of replayEvents) {
			const anyEv = ev as any;
			let logData: any | null = null;

			if (
				anyEv.type === EventType.IncrementalSnapshot &&
				anyEv.data?.source === IncrementalSource.Log
			) {
				logData = anyEv.data;
			} else if (anyEv.type === EventType.Plugin && anyEv.data?.plugin === "rrweb/console@1") {
				logData = anyEv.data.payload;
			}

			if (!logData) continue;
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
				trace: Array.isArray(logData.trace) ? logData.trace.map(String) : [],
			});
		}

		items.sort((a, b) => a.timestamp - b.timestamp);
		return items;
	}, [replayEvents]);

	useEffect(() => {
		const controller = new AbortController();
		let active = true;

		async function loadAndMount() {
			if (!playerHostRef.current) return;
			if (sortedSeqs.length === 0) {
				setReplayStatus({ state: "idle" });
				(playerRef.current as any)?.$destroy?.();
				playerRef.current = null;
				playerHostRef.current.innerHTML = "";
				return;
			}

			setReplayStatus({
				state: "loading",
				loaded: 0,
				total: sortedSeqs.length,
			});

			const events: eventWithTime[] = [];
			for (let i = 0; i < sortedSeqs.length; i++) {
				if (controller.signal.aborted) return;
				const seq = sortedSeqs[i];
				let payload: TurretReplayChunkPayload;
				try {
					payload = await getSessionChunk(sessionId, seq, {
						signal: controller.signal,
					});
				} catch (err) {
					if (!active || controller.signal.aborted) return;
					setReplayStatus({
						state: "error",
						message:
							err instanceof Error ? err.message : "Failed to load replay chunk",
					});
					return;
				}

				if (!active || controller.signal.aborted) return;

				if (payload && Array.isArray(payload.events)) {
					events.push(...(payload.events as eventWithTime[]));
				}

				setReplayStatus({
					state: "loading",
					loaded: i + 1,
					total: sortedSeqs.length,
				});
			}

			if (!active || controller.signal.aborted) return;

			(playerRef.current as any)?.$destroy?.();
			playerRef.current = null;
			playerHostRef.current.innerHTML = "";

			setReplayEvents(events);

			playerRef.current = new rrwebPlayer({
				target: playerHostRef.current,
				props: {
					events,
					autoPlay: false,
					showController: true,
				},
			});

			setReplayStatus({ state: "ready", totalEvents: events.length });
		}

		loadAndMount();

		return () => {
			active = false;
			controller.abort();
			(playerRef.current as any)?.$destroy?.();
			playerRef.current = null;
		};
	}, [sessionId, sortedSeqs]);

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Session</h1>
				<p className="text-sm text-muted-foreground">
					{sessionId}
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Replay</CardTitle>
				</CardHeader>
				<CardContent>
					{replayStatus.state === "idle" && sortedSeqs.length === 0 ? (
						<>
							<Empty>
								<EmptyHeader>
									<EmptyTitle>No replay data yet</EmptyTitle>
									<EmptyDescription>
										This session has no chunks indexed in Turret.
									</EmptyDescription>
								</EmptyHeader>
								<EmptyContent />
							</Empty>
							<div ref={playerHostRef} className="hidden" />
						</>
					) : (
						<div className="space-y-2">
							{replayStatus.state === "error" ? (
								<div className="text-sm text-destructive">
									Failed to load replay: {replayStatus.message}
								</div>
							) : replayStatus.state === "loading" ? (
								<div className="text-sm text-muted-foreground">
									Loading replay… {replayStatus.loaded}/{replayStatus.total}
								</div>
							) : replayStatus.state === "ready" ? (
								<div className="text-xs text-muted-foreground">
									Loaded {replayStatus.totalEvents} events
								</div>
							) : null}
							<div
								ref={playerHostRef}
								className="min-h-[420px] overflow-hidden rounded-md border bg-background"
							/>
						</div>
					)}
				</CardContent>
			</Card>

			<Tabs defaultValue="meta">
				<TabsList>
					<TabsTrigger value="meta">Metadata</TabsTrigger>
					<TabsTrigger value="errors">Errors</TabsTrigger>
					<TabsTrigger value="console">Console</TabsTrigger>
					<TabsTrigger value="issues">Issues</TabsTrigger>
					<TabsTrigger value="perf">Performance</TabsTrigger>
				</TabsList>

				<TabsContent value="meta" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Session metadata</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2 text-sm">
							{metaQuery.isLoading ? (
								<div className="text-muted-foreground">Loading…</div>
							) : metaQuery.isError ? (
								<div className="text-destructive">Failed to load metadata</div>
							) : !metaQuery.data ? (
								<div className="text-muted-foreground">No data</div>
							) : (
								<>
									<div>
										<span className="text-muted-foreground">Started:</span>{" "}
										{new Date(metaQuery.data.session.startedAt).toLocaleString()}
									</div>
									<div>
										<span className="text-muted-foreground">URL:</span>{" "}
										{metaQuery.data.session.lastUrl ?? metaQuery.data.session.initialUrl ?? "-"}
									</div>
									<div>
										<span className="text-muted-foreground">Chunks:</span>{" "}
										{metaQuery.data.session.chunkCount}
									</div>
									<div>
										<span className="text-muted-foreground">Errors:</span>{" "}
										{metaQuery.data.session.hasError ? "yes" : "no"}
									</div>
									<div>
										<span className="text-muted-foreground">Location:</span>{" "}
										{[metaQuery.data.session.country, metaQuery.data.session.colo]
											.filter(Boolean)
											.join(" /") || "-"}
									</div>
									<div className="pt-2 text-muted-foreground">
										Chunk index loaded: {chunksQuery.data?.chunks.length ?? 0}
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
								<div className="text-sm text-muted-foreground">Loading…</div>
							) : errorsQuery.isError ? (
								<div className="text-sm text-destructive">Failed to load errors</div>
							) : !errorsQuery.data || errorsQuery.data.errors.length === 0 ? (
								<div className="text-sm text-muted-foreground">No errors for this session.</div>
							) : (
								<div className="space-y-2">
									{errorsQuery.data.errors.map((e) => {
										const ts = new Date(e.ts).getTime();
										return (
									<div
										key={e.id}
										className="rounded-md border bg-card p-3"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0">
												<div className="text-sm font-medium">
													{e.message ?? "Error"}
												</div>
												<div className="mt-1 text-xs text-muted-foreground">
													{e.source} · {new Date(ts).toLocaleString()}
												</div>
											</div>
											<div className="flex items-center gap-2">
												<details className="text-xs">
													<summary className="cursor-pointer select-none text-muted-foreground">Stack</summary>
													{e.stack ? (
														<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug">
															{e.stack}
														</pre>
													) : (
														<div className="mt-2 text-muted-foreground">No stack</div>
													)}
												</details>
												<button
													type="button"
													className="rounded-md border px-2.5 py-1 text-xs"
													disabled={replayStatus.state !== "ready"}
													onClick={() => {
														const player = playerRef.current;
														if (!player) return;
														const meta = player.getMetaData?.();
														if (!meta || typeof meta.startTime !== "number") return;
														const startTime = meta.startTime;
														const totalTime = typeof meta.totalTime === "number" ? meta.totalTime : Infinity;
														const offset = Math.max(0, Math.min(totalTime, ts - startTime));
														player.goto(offset, false);
													}}
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

				<TabsContent value="console" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Console</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2">
							{replayStatus.state !== "ready" ? (
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
											<div key={`${ts}-${idx}`} className="rounded-md border bg-card p-3">
												<div className="flex flex-wrap items-start justify-between gap-3">
													<div className="min-w-0">
														<div className="text-sm font-medium">
															<span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
																{item.level}
															</span>
															{item.payload.map((p) => {
																if (typeof p === "string") return p;
																try {
																	return JSON.stringify(p);
																} catch {
																	return String(p);
																}
															})
															.join(" ")}
														</div>
														<div className="mt-1 text-xs text-muted-foreground">
															{new Date(ts).toLocaleString()}
														</div>
													</div>
													<div className="flex items-center gap-2">
														<details className="text-xs">
															<summary className="cursor-pointer select-none text-muted-foreground">
																Trace
															</summary>
															{item.trace.length > 0 ? (
																<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug">
																	{item.trace.join("\n")}
																</pre>
															) : (
																<div className="mt-2 text-muted-foreground">No trace</div>
															)}
														</details>
														<button
															type="button"
															className="rounded-md border px-2.5 py-1 text-xs"
															disabled={replayStatus.state !== "ready"}
															onClick={() => {
																const player = playerRef.current;
																if (!player) return;
																const meta = player.getMetaData?.();
																if (!meta || typeof meta.startTime !== "number") return;
																const startTime = meta.startTime;
																const totalTime = typeof meta.totalTime === "number" ? meta.totalTime : Infinity;
																const offset = Math.max(0, Math.min(totalTime, ts - startTime));
																player.goto(offset, false);
															}}
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
										Issue grouping, fingerprints, and trend charts.
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
								<div className="text-sm text-muted-foreground">Loading…</div>
							) : breadcrumbsQuery.isError ? (
								<div className="text-sm text-destructive">Failed to load breadcrumbs</div>
							) : !breadcrumbsQuery.data || breadcrumbsQuery.data.breadcrumbs.length === 0 ? (
								<div className="text-sm text-muted-foreground">No requests recorded for this session.</div>
							) : (
								<div className="space-y-2">
									{breadcrumbsQuery.data.breadcrumbs.map((b) => {
										const ts = new Date(b.ts).getTime();
										return (
											<RequestBreadcrumbRow
												key={b.id}
												breadcrumb={b}
												ts={ts}
												replayReady={replayStatus.state === "ready"}
												playerRef={playerRef}
											/>
										);
									})}
									<div className="flex items-center justify-between pt-2">
										<div className="text-xs text-muted-foreground">
											Offset {breadcrumbsOffset} · Showing {breadcrumbsQuery.data.breadcrumbs.length} · Limit {breadcrumbsLimit}
										</div>
										<div className="flex items-center gap-2">
											<button
												type="button"
												className="rounded-md border px-2.5 py-1 text-xs"
												disabled={breadcrumbsOffset === 0}
												onClick={() => setBreadcrumbsOffset(Math.max(0, breadcrumbsOffset - breadcrumbsLimit))}
											>
												Prev
											</button>
											<button
												type="button"
												className="rounded-md border px-2.5 py-1 text-xs"
												disabled={breadcrumbsQuery.data.breadcrumbs.length < breadcrumbsLimit}
												onClick={() => setBreadcrumbsOffset(breadcrumbsOffset + breadcrumbsLimit)}
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
