export type TurretInitResponse = {
	session_id: string;
	upload_token: string;
	policy_version: string;
	rrweb: Record<string, unknown>;
	console: {
		enabled: boolean;
		level: string[];
		lengthThreshold: number;
		stringifyOptions: {
			stringLengthLimit?: number;
			numOfKeysLimit: number;
			depthOfLimit: number;
		};
	};
};

export type TurretBlockedReason =
	| "rrweb_import_failed"
	| "rrweb_blocked_by_client";

type TurretSessionErrorPayload = {
	ts: number;
	source?: string;
	message?: string;
	stack?: string;
	fingerprint?: string;
	extra?: Record<string, unknown>;
};

async function turretInitSession(input: {
	journeyId: string;
	initialUrl: string;
}): Promise<TurretInitResponse> {
	const res = await fetch("/api/turret/session/init", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			journey_id: input.journeyId,
			initial_url: input.initialUrl,
		}),
	});

	if (!res.ok) {
		let payload: unknown;
		try {
			payload = await res.clone().json();
		} catch {
			payload = undefined;
		}

		const msg =
			(typeof payload === "object" && payload && "error" in payload &&
				(typeof (payload as any).error === "string")
				? (payload as any).error
				: `Turret init failed: ${res.status}`);
		throw new Error(msg);
	}

	return res.json() as Promise<TurretInitResponse>;
}

async function turretUploadChunk(input: {
	sessionId: string;
	uploadToken: string;
	seq: number;
	events: unknown[];
	tsStart: number;
	tsEnd: number;
	signal?: AbortSignal;
}): Promise<void> {
	const res = await fetch(`/api/turret/session/${encodeURIComponent(input.sessionId)}/chunk`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${input.uploadToken}`,
		},
		body: JSON.stringify({
			seq: input.seq,
			events: input.events,
			ts_start: input.tsStart,
			ts_end: input.tsEnd,
		}),
		signal: input.signal,
	});

	if (!res.ok) {
		throw new Error(`Turret chunk upload failed: ${res.status}`);
	}
}

async function turretMarkCaptureBlocked(input: {
	sessionId: string;
	uploadToken: string;
	reason: TurretBlockedReason;
	message?: string;
}): Promise<void> {
	const res = await fetch(
		`/api/turret/session/${encodeURIComponent(input.sessionId)}/blocked`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.uploadToken}`,
			},
			body: JSON.stringify({
				reason: input.reason,
				message: input.message,
			}),
		}
	);
	if (!res.ok) {
		throw new Error(`Turret blocked marker failed: ${res.status}`);
	}
}

async function turretReportSessionError(input: {
	sessionId: string;
	uploadToken: string;
	payload: TurretSessionErrorPayload;
	signal?: AbortSignal;
}): Promise<void> {
	const res = await fetch(
		`/api/turret/session/${encodeURIComponent(input.sessionId)}/error`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.uploadToken}`,
			},
			body: JSON.stringify(input.payload),
			signal: input.signal,
		}
	);
	if (!res.ok) {
		throw new Error(`Turret error report failed: ${res.status}`);
	}
}

export {
	turretInitSession,
	turretUploadChunk,
	turretMarkCaptureBlocked,
	turretReportSessionError,
};
