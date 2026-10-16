type SessionState = {
	data: { user: { id: string } } | null;
	isPending: boolean;
	error: unknown;
};

type SessionSource = {
	subscribe: (listener: (state: SessionState) => void) => () => void;
};

// Better Auth's client keeps its atoms in a string-keyed record.
export function sessionSource(
	atoms: Readonly<Record<string, SessionSource>>
): SessionSource {
	const session = atoms.session;
	if (session === undefined)
		throw new Error("Better Auth's client exposes no session atom.");
	return session;
}

// Subscribing mounts Better Auth's session refresh, including cross-tab updates.
// Both React and Astro use this owner; neither starts or stops a recorder itself.
export function observeTurretCapture(source: SessionSource): () => void {
	let userId: string | null = null;
	let generation = 0;
	let capture: { stop: () => Promise<void> } | undefined;
	function stop() {
		generation++;
		const previous = capture;
		capture = undefined;
		// stop() cancels recording and clears context synchronously.
		void previous?.stop().catch(reportFailure);
	}
	function reportFailure(error: unknown) {
		if (import.meta.env.DEV) console.warn("Turret lifecycle failed", error);
	}
	const unsubscribe = source.subscribe((state) => {
		if (state.isPending) return;
		const nextUserId = state.error ? null : (state.data?.user.id ?? null);
		if (nextUserId === userId) return;
		stop();
		userId = nextUserId;
		if (!userId) return;
		const current = generation;
		// Keep rrweb and capture code out of unauthenticated page startup.
		void import("./session")
			.then((mod) => {
				if (generation !== current) return;
				capture = mod.createTurretSession();
			})
			.catch(reportFailure);
	});
	return () => {
		unsubscribe();
		userId = null;
		stop();
	};
}
