import assert from "node:assert/strict";
import test from "node:test";
import {
	discardUnreadBody,
	UNREAD_BODY_DRAIN_BYTES_MAX,
} from "../../src/worker/http/unread-body";

const CHUNK_BYTES = 65_536;

// A request body that counts what was pulled from it and whether it was cancelled.
function streamedRequest(totalBytes: number) {
	const state = { pulledBytes: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulledBytes >= totalBytes) {
				controller.close();
				return;
			}
			const sizeBytes = Math.min(
				CHUNK_BYTES,
				totalBytes - state.pulledBytes
			);
			state.pulledBytes += sizeBytes;
			controller.enqueue(new Uint8Array(sizeBytes));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	const init = { method: "POST", body, duplex: "half" };
	const request = new Request("http://localhost/api/upload", init);
	return { request, state };
}

test("reads an unread body to the end", async () => {
	const { request, state } = streamedRequest(200_000);
	await discardUnreadBody(request);
	assert.equal(state.pulledBytes, 200_000);
	assert.equal(state.cancelled, false);
	assert.equal(request.bodyUsed, true);
});

test("cancels past the bound instead of reading an unbounded body", async () => {
	const { request, state } = streamedRequest(UNREAD_BODY_DRAIN_BYTES_MAX * 8);
	await discardUnreadBody(request);
	assert.equal(state.cancelled, true);
	assert.ok(
		state.pulledBytes <= UNREAD_BODY_DRAIN_BYTES_MAX + 2 * CHUNK_BYTES
	);
});

test("leaves bodies a handler read, or is reading, and bodiless requests alone", async () => {
	const read = streamedRequest(1_000);
	await read.request.arrayBuffer();
	await discardUnreadBody(read.request);
	const reading = streamedRequest(1_000);
	const reader = reading.request.body?.getReader();
	await discardUnreadBody(reading.request);
	assert.equal(reading.state.cancelled, false);
	reader?.releaseLock();
	await discardUnreadBody(new Request("http://localhost/api/health"));
});
