declare global {
	interface Window {
		__turretAutoStarted?: boolean;
	}
}

async function hasAuthenticatedSession(): Promise<boolean> {
	try {
		const res = await fetch("/api/auth/get-session", {
			method: "GET",
			credentials: "include",
			cache: "no-store",
		});
		if (!res.ok) return false;
		const payload = (await res.json()) as unknown;
		return Boolean((payload as { user?: unknown } | null | undefined)?.user);
	} catch {
		return false;
	}
}

async function start(): Promise<void> {
	if (typeof window === "undefined") return;
	if (window.__turretAutoStarted) return;
	window.__turretAutoStarted = true;

	if (!(await hasAuthenticatedSession())) return;

	// Lazy-load capture so we don't pull rrweb unless we're signed in.
	const mod = await import("../react-app/lib/turretCapture");
	mod.createTurretCapture();
}

void start();

export {};
