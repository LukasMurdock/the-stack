import { eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { turretReplayChunkSchema } from "../../contracts/turret";
import type { TurretDb } from "../../bindings/d1/turret/db";
import {
	turretSessionChunks,
	turretSessions,
} from "../../bindings/d1/turret/schema";
import { replayChunkKey } from "./retention";

async function sha256(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

// The object is immutable; retries repair D1 after a partial commit without
// overwriting a sequence or incrementing its count twice.
export async function commitReplayChunk(
	db: TurretDb,
	bucket: Pick<R2Bucket, "put" | "get">,
	sessionId: string,
	chunk: z.infer<typeof turretReplayChunkSchema>,
	now: number
): Promise<"committed" | "conflict"> {
	const r2Key = replayChunkKey(sessionId, chunk.seq);
	const json = JSON.stringify(chunk);
	const bytes = new TextEncoder().encode(json);
	const digest = await sha256(json);
	const stored = await bucket.put(r2Key, json, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
		customMetadata: { sha256: digest },
	});
	if (!stored) {
		const existing = await bucket.get(r2Key);
		if (!existing)
			throw new Error("Replay chunk disappeared during commit.");
		// Reading legacy objects also works when their checksum metadata is absent.
		const existingDigest =
			existing.customMetadata?.sha256 ??
			(await sha256(await existing.text()));
		if (existingDigest !== digest) return "conflict";
	}
	let minTs: number | null = null;
	let maxTs: number | null = null;
	for (const event of chunk.events) {
		if (!event || typeof event !== "object" || !("timestamp" in event))
			continue;
		const ts = event.timestamp;
		if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
		minTs = minTs === null ? ts : Math.min(minTs, ts);
		maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
	}
	await db.batch([
		db
			.insert(turretSessionChunks)
			.values({
				sessionId,
				seq: chunk.seq,
				r2Key,
				size: bytes.byteLength,
				sha256: digest,
				createdAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [
					turretSessionChunks.sessionId,
					turretSessionChunks.seq,
				],
				set: { sha256: digest, size: bytes.byteLength },
			}),
		db
			.update(turretSessions)
			.set({
				chunkCount: sql`(SELECT count(*) FROM ${turretSessionChunks} WHERE ${turretSessionChunks.sessionId} = ${sessionId})`,
				rrwebStartTsMs:
					minTs === null
						? turretSessions.rrwebStartTsMs
						: sql`CASE WHEN ${turretSessions.rrwebStartTsMs} IS NULL THEN ${minTs} ELSE min(${turretSessions.rrwebStartTsMs}, ${minTs}) END`,
				rrwebLastTsMs:
					maxTs === null
						? turretSessions.rrwebLastTsMs
						: sql`CASE WHEN ${turretSessions.rrwebLastTsMs} IS NULL THEN ${maxTs} ELSE max(${turretSessions.rrwebLastTsMs}, ${maxTs}) END`,
				updatedAt: new Date(now),
			})
			.where(eq(turretSessions.sessionId, sessionId)),
	]);
	return "committed";
}
