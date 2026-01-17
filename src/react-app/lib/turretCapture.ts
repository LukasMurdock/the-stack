import type { eventWithTime, listenerHandler } from "@rrweb/types";
import {
	turretInitSession,
	turretMarkCaptureBlocked,
	turretUploadChunk,
} from "./turretIngestApi";
import { setLastRrwebTsMs, setTurretContext, clearTurretContext } from "./turretContext";

const JOURNEY_KEY = "turret:journey_id";

function getOrCreateJourneyId(): string {
	const existing = sessionStorage.getItem(JOURNEY_KEY);
	if (existing) return existing;
	const created = crypto.randomUUID();
	sessionStorage.setItem(JOURNEY_KEY, created);
	return created;
}

type TurretCaptureHandle = {
	stop: () => Promise<void>;
};

type TurretCaptureOptions = {
	flushMs?: number;
	maxEvents?: number;
	maxChunkBytes?: number;
};

function createTurretCapture(options?: TurretCaptureOptions): TurretCaptureHandle {
	const flushMs = options?.flushMs ?? 2000;
	const maxEvents = options?.maxEvents ?? 200;
	// Keep below worker cap (512KB) to account for JSON wrapper overhead.
	const maxChunkBytes = options?.maxChunkBytes ?? 380_000;

	const controller = new AbortController();
	let stopped = false;
	let uploadToken: string | null = null;
	let sessionId: string | null = null;
	let rrwebStop: listenerHandler | undefined;

	let seq = 0;
	let buffer: eventWithTime[] = [];
	let bufferBytes = 0;
	let bufferStartTs = Date.now();
	let flushTimer: number | null = null;
	let flushing: Promise<void> | null = null;

	function scheduleFlush() {
		if (flushTimer != null) return;
		flushTimer = window.setTimeout(() => {
			flushTimer = null;
			void flush();
		}, flushMs);
	}

	async function flush() {
		if (stopped) return;
		if (!sessionId || !uploadToken) return;
		if (buffer.length === 0) return;
		if (flushing) return flushing;

		const events = buffer;
		const tsStart = bufferStartTs;
		const tsEnd = Date.now();
		buffer = [];
		bufferBytes = 0;
		bufferStartTs = tsEnd;

		flushing = turretUploadChunk({
			sessionId,
			uploadToken,
			seq,
			events,
			tsStart,
			tsEnd,
			signal: controller.signal,
		})
			.then(() => {
				seq += 1;
			})
			.finally(() => {
				flushing = null;
			});

		return flushing;
	}

	function onEmit(ev: eventWithTime) {
		// Estimate payload growth. We intentionally over-count a bit so we flush
		// before hitting the worker's Content-Length cap (512KB).
		// NOTE: avoid JSON.stringify(buffer) here to keep hot path cheap.
		try {
			bufferBytes += JSON.stringify(ev).length;
		} catch {
			// If something is not serializable, rrweb might still serialize it internally.
			// Keep the recorder running.
		}

		buffer.push(ev);
		if (typeof ev.timestamp === "number") {
			setLastRrwebTsMs(ev.timestamp);
		}
		if (buffer.length === 1) {
			bufferStartTs = Date.now();
		}

		if (bufferBytes >= maxChunkBytes || buffer.length >= maxEvents) {
			void flush();
			return;
		}

		scheduleFlush();
	}

	async function init() {
		const journeyId = getOrCreateJourneyId();
		const initRes = await turretInitSession({
			journeyId,
			initialUrl: window.location.href,
		});
		sessionId = initRes.session_id;
		uploadToken = initRes.upload_token;
		setTurretContext({ sessionId, uploadToken });

		// Start recording with server-provided rrweb policy config.
		// Important: rrweb import can be blocked by content blockers.
		// In that case, capture should fail closed (no replay) without impacting the app.
		try {
			const rrweb = await import("rrweb");

			const plugins: any[] = [];
			if (initRes.console?.enabled) {
				plugins.push(
					rrweb.getRecordConsolePlugin({
						level: initRes.console.level as any,
						lengthThreshold: initRes.console.lengthThreshold,
						stringifyOptions: initRes.console.stringifyOptions as any,
						logger: "console",
					})
				);
			}

			rrwebStop = rrweb.record({
				emit: onEmit,
				plugins,
				// Compliance defaults come from the server.
				...(initRes.rrweb ?? {}),
			});
		} catch (err) {
			// rrweb import may be blocked by extensions. Record that fact server-side
			// so we can measure capture reliability.
			await turretMarkCaptureBlocked({
				sessionId: initRes.session_id,
				uploadToken: initRes.upload_token,
				reason: "rrweb_blocked_by_client",
				message: err instanceof Error ? err.message : "blocked",
			});
			throw err;
		}

		// Flush on backgrounding.
		const flushOnHide = () => {
			if (document.visibilityState === "hidden") void flush();
		};
		document.addEventListener("visibilitychange", flushOnHide);
		window.addEventListener("pagehide", () => void flush());

		// Also flush periodically.
		scheduleFlush();

		return () => {
			document.removeEventListener("visibilitychange", flushOnHide);
		};
	}

	let cleanupListeners: (() => void) | null = null;

	// Fire async init, but never throw to the caller.
	void (async () => {
		try {
			cleanupListeners = await init();
		} catch (err) {
			// Common causes:
			// - missing TURRET_SIGNING_KEY -> 500
			// - APP_URL origin mismatch -> 403
			if (import.meta.env.DEV) {
				console.warn("Turret capture failed to start", err);
			}
		}
	})();

	return {
		stop: async () => {
			stopped = true;
			controller.abort();
			cleanupListeners?.();
			clearTurretContext();
			cleanupListeners = null;
			if (flushTimer != null) {
				window.clearTimeout(flushTimer);
				flushTimer = null;
			}
			try {
				await flush();
			} catch {
				// ignore
			}
			try {
				rrwebStop?.();
			} catch {
				// ignore
			}
		},
	};
}

export { createTurretCapture };
