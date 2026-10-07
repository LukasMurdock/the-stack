// The limit applies to the complete UTF-8 JSON request, including its envelope.
export const REPLAY_CHUNK_BYTES_MAX = 512_000;
export const REPLAY_CHUNK_TARGET_BYTES = Math.floor(
	REPLAY_CHUNK_BYTES_MAX * 0.75
);

export function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
