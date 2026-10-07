import { isRecord } from "@/lib/isRecord";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { eventWithTime } from "@rrweb/types";

import { turretReplaySessionChunksQueryOptions } from "../queries";
import { loadReplayEvents } from "./replayLoader";
import {
	jumpReplayToTimestamp,
	type RrwebPlayerInstance,
} from "./replayPlayer";

export type ReplayConsoleItem = {
	timestamp: number;
	level: string;
	payload: unknown[];
	trace: string[];
};

type ReplayStatus =
	| { state: "idle" }
	| { state: "loading"; loaded: number; total: number }
	| {
			state: "ready";
			sessionId: string;
			seqs: number[];
			events: eventWithTime[];
	  }
	| { state: "error"; message: string };

const noSeqs: number[] = [];

export function extractConsoleItems(
	events: eventWithTime[]
): ReplayConsoleItem[] {
	const items: ReplayConsoleItem[] = [];
	for (const ev of events) {
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
		const logData: unknown = data.payload;
		if (!isRecord(logData)) continue;

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
}

export function formatConsolePayload(payload: unknown[]): string {
	return payload
		.map((p) => {
			if (typeof p === "string") return p;
			try {
				return JSON.stringify(p);
			} catch {
				return String(p);
			}
		})
		.join(" ");
}

// Mounts an rrweb player for one replay session. `startAt` positions playback
// once per key after the replay loads, so later URL updates from manual jumps
// don't move the player again.
export function useReplayPlayer(
	sessionId: string | null,
	options?: { startAt?: { key: string; ts: number } }
) {
	const chunksQuery = useQuery({
		...turretReplaySessionChunksQueryOptions(sessionId ?? ""),
		enabled: sessionId !== null,
	});
	const playerHostRef = useRef<HTMLDivElement | null>(null);
	const playerRef = useRef<RrwebPlayerInstance | null>(null);

	const sortedSeqs = useMemo(() => {
		const chunks = chunksQuery.data?.chunks;
		if (!sessionId || !chunks) return noSeqs;
		return chunks
			.map((c) => c.seq)
			.filter((s) => Number.isFinite(s))
			.sort((a, b) => a - b);
	}, [chunksQuery.data?.chunks, sessionId]);

	const [status, setStatus] = useState<ReplayStatus>({ state: "idle" });

	// A previous session or chunk set cannot enable controls before its effect cleans up.
	const ready =
		status.state === "ready" &&
		status.sessionId === sessionId &&
		status.seqs === sortedSeqs;

	const consoleItems = useMemo(
		() =>
			ready && status.state === "ready"
				? extractConsoleItems(status.events)
				: [],
		[status, ready]
	);

	useEffect(() => {
		const controller = new AbortController();
		const currentHost = playerHostRef.current;
		if (!currentHost || !sessionId) return;
		const host = currentHost;
		const replaySessionId = sessionId;
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
				setStatus({ state: "idle" });
				return;
			}
			setStatus({
				state: "loading",
				loaded: 0,
				total: sortedSeqs.length,
			});
			await import("rrweb-player/dist/style.css");
			const { default: ReplayPlayer } = await import("rrweb-player");
			if (!active || controller.signal.aborted) return;
			const events = await loadReplayEvents({
				sessionId: replaySessionId,
				seqs: sortedSeqs,
				signal: controller.signal,
				onProgress: (loaded, total) => {
					if (active && !controller.signal.aborted)
						setStatus({ state: "loading", loaded, total });
				},
			});
			if (!active || controller.signal.aborted) return;
			player = new ReplayPlayer({
				target: host,
				props: { events, autoPlay: false, showController: true },
			});
			playerRef.current = player;
			setStatus({
				state: "ready",
				sessionId: replaySessionId,
				seqs: sortedSeqs,
				events,
			});
		}

		void loadAndMount().catch((error: unknown) => {
			if (!active || controller.signal.aborted) return;
			clearPlayer();
			setStatus({
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

	const startAt = options?.startAt;
	const positionedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!ready || !startAt || positionedFor.current === startAt.key) return;
		positionedFor.current = startAt.key;
		jumpReplayToTimestamp(playerRef.current, startAt.ts);
	}, [ready, startAt]);

	return {
		chunksQuery,
		playerHostRef,
		sortedSeqs,
		status,
		ready,
		consoleItems,
		seek: (ts: number) => jumpReplayToTimestamp(playerRef.current, ts),
	};
}
