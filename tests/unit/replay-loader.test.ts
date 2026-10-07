import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../src/react-app/api";
import { loadReplayEvents } from "../../src/react-app/features/turret/session/replayLoader";

test("a failed replay chunk rejects the load and cancels sibling requests without publishing progress", async (t) => {
	const signals: AbortSignal[] = [];
	const progress: number[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const signal = init?.signal;
			assert.ok(signal);
			signals.push(signal);
			const url = input instanceof Request ? input.url : String(input);
			if (new URL(url, "https://app.test").pathname.endsWith("/0"))
				return Response.json(
					{ error: "Chunk unavailable" },
					{ status: 500 }
				);
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true }
				);
			});
		}
	);
	await assert.rejects(
		loadReplayEvents({
			sessionId: "session",
			seqs: [0, 1],
			signal: new AbortController().signal,
			onProgress: (loaded) => progress.push(loaded),
		}),
		(error: unknown) =>
			error instanceof ApiError &&
			error.status === 500 &&
			error.message === "Chunk unavailable"
	);
	assert.equal(signals.length, 2);
	assert.ok(signals.every((signal) => signal.aborted));
	assert.deepEqual(progress, []);
});
