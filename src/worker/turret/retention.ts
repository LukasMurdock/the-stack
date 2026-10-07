import type { TurretDb } from "../../bindings/d1/turret/db";
import { and, eq, gt, inArray, lte } from "drizzle-orm";
import * as schema from "../../bindings/d1/turret/schema";

function replaySessionPrefix(sessionId: string) {
	return `replay/v1/${sessionId}/`;
}

export function replayChunkKey(sessionId: string, seq: number) {
	return `${replaySessionPrefix(sessionId)}chunk/${String(seq).padStart(8, "0")}.json`;
}

export function retainedReplay(now = Date.now()) {
	return gt(schema.turretSessions.retentionExpiresAt, new Date(now));
}

export function readRetainedReplay(
	db: TurretDb,
	sessionId: string,
	now = Date.now()
) {
	return db.query.turretSessions.findFirst({
		where: and(
			eq(schema.turretSessions.sessionId, sessionId),
			retainedReplay(now)
		),
	});
}

const REPLAY_CLEANUP_BATCH = 99; // Leaves one D1 parameter for sessionId.

// Bound each run to ten sessions, 99 metadata rows and 99 listed objects per
// session. Remaining metadata and the session prefix let later runs resume.
export async function cleanupTurretStorage(
	db: TurretDb,
	bucket: Pick<R2Bucket, "delete" | "list">,
	now: number
) {
	const expired = new Date(now);
	await db
		.delete(schema.turretRequestSpans)
		.where(lte(schema.turretRequestSpans.expiresAt, expired));
	await db
		.delete(schema.turretRequestBreadcrumbs)
		.where(lte(schema.turretRequestBreadcrumbs.expiresAt, expired));
	await db
		.delete(schema.turretSessionErrors)
		.where(lte(schema.turretSessionErrors.expiresAt, expired));
	await db
		.delete(schema.turretUserFeedback)
		.where(lte(schema.turretUserFeedback.expiresAt, expired));
	const sessions = await db.query.turretSessions.findMany({
		where: lte(schema.turretSessions.retentionExpiresAt, expired),
		columns: { sessionId: true },
		orderBy: (t, ops) => [
			ops.asc(t.retentionExpiresAt),
			ops.asc(t.sessionId),
		],
		limit: 10,
	});
	let deletedSessions = 0;
	let deletedChunks = 0;
	for (const { sessionId } of sessions) {
		// Include objects whose upload succeeded but metadata persistence failed.
		const objects = await bucket.list({
			prefix: replaySessionPrefix(sessionId),
			limit: REPLAY_CLEANUP_BATCH,
		});
		const chunks = await db.query.turretSessionChunks.findMany({
			where: eq(schema.turretSessionChunks.sessionId, sessionId),
			columns: { r2Key: true },
			orderBy: (t, ops) => [ops.asc(t.seq)],
			limit: REPLAY_CLEANUP_BATCH,
		});
		const chunkKeys = chunks.map((chunk) => chunk.r2Key);
		const keys = [
			...new Set([
				...chunkKeys,
				...objects.objects.map((object) => object.key),
			]),
		];
		if (keys.length) {
			// R2 deletion is idempotent. Keep metadata until it succeeds, including on
			// partial failures, so a retry never loses the keys needed to finish.
			// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Deletes only the selected R2 object keys, not database rows.
			await bucket.delete(keys);
		}
		if (chunkKeys.length) {
			await db
				.delete(schema.turretSessionChunks)
				.where(
					and(
						eq(schema.turretSessionChunks.sessionId, sessionId),
						inArray(schema.turretSessionChunks.r2Key, chunkKeys)
					)
				);
			deletedChunks += chunks.length;
		}
		const remaining = await db.query.turretSessionChunks.findFirst({
			where: eq(schema.turretSessionChunks.sessionId, sessionId),
			columns: { r2Key: true },
		});
		if (!remaining) {
			const remainingObjects = await bucket.list({
				prefix: replaySessionPrefix(sessionId),
				limit: 1,
			});
			if (remainingObjects.objects.length) continue;
			// Include older linked rows whose nullable expiry predates retention metadata.
			await db
				.delete(schema.turretSessionErrors)
				.where(eq(schema.turretSessionErrors.sessionId, sessionId));
			await db
				.delete(schema.turretUserFeedback)
				.where(eq(schema.turretUserFeedback.sessionId, sessionId));
			await db
				.delete(schema.turretSessions)
				.where(
					and(
						eq(schema.turretSessions.sessionId, sessionId),
						lte(schema.turretSessions.retentionExpiresAt, expired)
					)
				);
			deletedSessions++;
		}
	}
	return { deletedSessions, deletedChunks };
}

const UNLINKED_TELEMETRY_RETENTION_MS = 24 * 60 * 60 * 1000;
export function telemetryExpiry(
	now: number,
	sessionExpiry?: Date | null
): number {
	if (
		sessionExpiry instanceof Date &&
		Number.isFinite(sessionExpiry.getTime())
	)
		return sessionExpiry.getTime();
	return now + UNLINKED_TELEMETRY_RETENTION_MS;
}

export async function readTelemetryExpiry(
	db: TurretDb,
	sessionId: string | null | undefined,
	now: number
): Promise<number> {
	if (sessionId) {
		try {
			const session = await db.query.turretSessions.findFirst({
				where: (t, ops) => ops.eq(t.sessionId, sessionId),
				columns: { retentionExpiresAt: true },
			});
			return telemetryExpiry(now, session?.retentionExpiresAt);
		} catch {
			// Telemetry remains best effort when session storage is unavailable.
		}
	}
	return telemetryExpiry(now);
}
