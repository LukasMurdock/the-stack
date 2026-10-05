import { isRecord } from "@/lib/isRecord";
import type { eventWithTime } from "@rrweb/types";

import { getReplaySessionChunk } from "../../../lib/turretApi";

export const REPLAY_CHUNK_CONCURRENCY = 6;

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export function decodeReplayEvents(events: unknown[]): eventWithTime[] {
	for (const event of events) {
		if (
			!isRecord(event) ||
			typeof event.type !== "number" ||
			!Number.isInteger(event.type) ||
			event.type < 0 ||
			event.type > 7 ||
			typeof event.timestamp !== "number" ||
			!Number.isFinite(event.timestamp) ||
			!("data" in event)
		) {
			throw new Error("Invalid replay event envelope");
		}
	}
	// SAFETY: tags (rrweb 2's event types 0–7), finite timestamps, and data presence were checked above. Nested payloads pass through under the owned rrweb recorder/replayer contract.
	return events as eventWithTime[];
}

export async function loadReplayEvents(input: {
	sessionId: string;
	seqs: number[];
	signal: AbortSignal;
	onProgress: (loaded: number, total: number) => void;
}): Promise<eventWithTime[]> {
	const { sessionId, seqs, signal, onProgress } = input;
	const total = seqs.length;
	if (total === 0) return [];

	const results: eventWithTime[][] = Array.from({ length: total }, () => []);
	const loadController = new AbortController();
	const abortLoad = () => loadController.abort();
	signal.addEventListener("abort", abortLoad);

	let nextIndex = 0;
	let loaded = 0;
	const workerCount = Math.min(REPLAY_CHUNK_CONCURRENCY, total);

	try {
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (!signal.aborted && !loadController.signal.aborted) {
					const index = nextIndex;
					nextIndex += 1;
					if (index >= total) return;

					const seq = seqs[index];
					const payload = await getReplaySessionChunk(
						sessionId,
						seq,
						{
							signal: loadController.signal,
						}
					);

					if (signal.aborted || loadController.signal.aborted) return;

					if (payload && Array.isArray(payload.events)) {
						results[index] = decodeReplayEvents(payload.events);
					}

					loaded += 1;
					onProgress(loaded, total);
				}
			})
		);
	} catch (error) {
		if (!isAbortError(error)) {
			loadController.abort();
		}
		throw error;
	} finally {
		signal.removeEventListener("abort", abortLoad);
	}

	return results.flat();
}
