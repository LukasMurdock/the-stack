type TurretClientContext = {
	sessionId: string;
	uploadToken: string;
	lastRrwebTsMs: number | null;
};

let ctx: TurretClientContext | null = null;

function setTurretContext(next: { sessionId: string; uploadToken: string }): void {
	ctx = {
		sessionId: next.sessionId,
		uploadToken: next.uploadToken,
		lastRrwebTsMs: null,
	};
}

function clearTurretContext(): void {
	ctx = null;
}

function setLastRrwebTsMs(ts: number): void {
	if (!ctx) return;
	ctx.lastRrwebTsMs = ts;
}

function getTurretContext(): TurretClientContext | null {
	return ctx;
}

export { setTurretContext, clearTurretContext, setLastRrwebTsMs, getTurretContext };
export type { TurretClientContext };
