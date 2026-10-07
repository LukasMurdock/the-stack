import { z } from "zod";
import { turretTimestampMsSchema } from "./turret-time-range";

const sessionHeader = "x-turret-session-id";
const replayTimestampHeader = "x-turret-replay-ts";
const sessionIdSchema = z.string().min(1).max(128);

export function turretCorrelationHeaders(
	session: { sessionId: string; lastRrwebTsMs: number | null },
	now: number
): Record<string, string> {
	return {
		[sessionHeader]: session.sessionId,
		[replayTimestampHeader]: String(session.lastRrwebTsMs ?? now),
	};
}
// Correlation is optional telemetry metadata, not authorization. Invalid values fall back without failing the request.
export function readTurretCorrelation(headers: Headers, now: number) {
	const session = sessionIdSchema.safeParse(headers.get(sessionHeader));
	const replay = turretTimestampMsSchema.safeParse(
		headers.get(replayTimestampHeader)
	);
	const replayTs = replay.success ? replay.data : null;
	return {
		sessionId: session.success ? session.data : null,
		replayTs,
		ts: replayTs ?? now,
	};
}
export type TurretCorrelation = ReturnType<typeof readTurretCorrelation>;
