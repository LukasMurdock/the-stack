type TurretClientContext = {
	sessionId: string;
	uploadToken: string;
	expiresAt: number;
	lastRrwebTsMs: number | null;
};

let ctx: TurretClientContext | null = null;
const sessionListeners = new Set<() => void>();
// React views observe session availability; recorder timestamps remain imperative.
export function subscribeTurretSession(listener: () => void) {
	sessionListeners.add(listener);
	return () => {
		// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes a Set observer, not a database row.
		sessionListeners.delete(listener);
	};
}
function notifySessionChange() {
	for (const listener of sessionListeners) listener();
}

function setTurretContext(next: {
	sessionId: string;
	uploadToken: string;
	expiresAt: number;
}): void {
	ctx = {
		sessionId: next.sessionId,
		uploadToken: next.uploadToken,
		expiresAt: next.expiresAt,
		lastRrwebTsMs: null,
	};
	notifySessionChange();
}

function clearTurretContext(sessionId: string): void {
	if (ctx?.sessionId !== sessionId) return;
	ctx = null;
	notifySessionChange();
}

function setLastRrwebTsMs(sessionId: string, ts: number | null): void {
	if (!ctx || ctx.sessionId !== sessionId) return;
	ctx.lastRrwebTsMs = ts;
}

function getTurretContext(): TurretClientContext | null {
	// Timers can be suspended in background tabs; callers must never use an
	// expired token while waiting for the lifecycle's deadline timer to run.
	return ctx && Date.now() < ctx.expiresAt ? ctx : null;
}

export {
	setTurretContext,
	clearTurretContext,
	setLastRrwebTsMs,
	getTurretContext,
};
export type { TurretClientContext };
