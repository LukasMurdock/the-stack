import { eq, sql } from "drizzle-orm";
import type { TurretDb } from "../../bindings/d1/turret/db";
import {
	turretSessionErrors,
	turretSessions,
} from "../../bindings/d1/turret/schema";
import { readTelemetryExpiry } from "./retention";

// Both client ingestion and worker capture persist the same error fields.
// Normalize only at storage; fingerprinting must still see the original error.
function normalizeErrorRecord(input: {
	message?: string | null;
	stack?: string | null;
	fingerprint?: string | null;
}) {
	return {
		message: input.message ? input.message.slice(0, 2000) : null,
		stack: input.stack ? input.stack.slice(0, 20000) : null,
		fingerprint: input.fingerprint ? input.fingerprint.slice(0, 256) : null,
	};
}

// An error and its existing session's flags/count must commit together. Unlinked
// worker errors remain valid telemetry and do not require a replay session.
export async function persistError(
	db: TurretDb,
	input: Omit<
		typeof turretSessionErrors.$inferInsert,
		"id" | "createdAt" | "expiresAt"
	>,
	now = Date.now()
) {
	const sessionId = input.sessionId ?? null;
	const expiresAt = await readTelemetryExpiry(db, sessionId, now);
	const insert = db.insert(turretSessionErrors).values({
		...input,
		...normalizeErrorRecord(input),
		id: crypto.randomUUID(),
		sessionId,
		source: input.source.slice(0, 64),
		expiresAt: new Date(expiresAt),
		createdAt: new Date(now),
	});
	if (!sessionId) {
		await insert;
		return;
	}
	await db.batch([
		insert,
		db
			.update(turretSessions)
			.set({
				hasError: true,
				errorCount: sql`${turretSessions.errorCount} + 1`,
				updatedAt: new Date(now),
			})
			.where(eq(turretSessions.sessionId, sessionId)),
	]);
}
