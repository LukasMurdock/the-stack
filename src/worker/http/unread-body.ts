// workerd closes a connection whose request body was not read to the end. A
// client that has already pooled that connection for its next request fails
// with ECONNRESET: locally that client is Miniflare's dispatchFetch, behind
// `pnpm dev`, `pnpm preview` and the browser tests. Cancelling the stream
// leaves the bytes on the wire, so read and discard what is left instead, up
// to a bound, and cancel past it. Bytes are discarded as they arrive. This
// runs once the response exists, so no handler may read its request body
// after returning a response.

// Twice the largest body any route accepts (REPLAY_CHUNK_BYTES_MAX).
export const UNREAD_BODY_DRAIN_BYTES_MAX = 1_048_576;

export async function discardUnreadBody(request: Request): Promise<void> {
	const body = request.body;
	// A handler that started reading owns the stream, including a partial read.
	if (body === null || request.bodyUsed || body.locked) return;
	const reader = body.getReader();
	let drainedBytes = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) return;
		drainedBytes += chunk.value.byteLength;
		if (drainedBytes > UNREAD_BODY_DRAIN_BYTES_MAX) {
			await reader.cancel();
			return;
		}
	}
}
