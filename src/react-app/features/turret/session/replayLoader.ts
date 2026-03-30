import type { eventWithTime } from "@rrweb/types";

import { getSessionChunk } from "../../../lib/turretApi";

export const REPLAY_CHUNK_CONCURRENCY = 6;

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
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
					const payload = await getSessionChunk(sessionId, seq, {
						signal: loadController.signal,
					});

					if (signal.aborted || loadController.signal.aborted) return;

					if (payload && Array.isArray(payload.events)) {
						results[index] = payload.events as eventWithTime[];
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
