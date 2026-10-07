import {
	REPLAY_CHUNK_TARGET_BYTES,
	jsonBytes,
} from "../../../contracts/turret-ingest";
import type { eventWithTime, listenerHandler } from "@rrweb/types";
import { ApiError } from "../../api";
import {
	turretInitReplaySession,
	turretMarkCaptureBlocked,
	turretUploadChunk,
	type TurretBlockedReason,
} from "./ingest";
import {
	setLastRrwebTsMs,
	setTurretContext,
	clearTurretContext,
} from "./context";

const JOURNEY_KEY = "turret:journey_id";

function getOrCreateJourneyId(): string {
	const existing = sessionStorage.getItem(JOURNEY_KEY);
	if (existing) return existing;
	const created = crypto.randomUUID();
	sessionStorage.setItem(JOURNEY_KEY, created);
	return created;
}

type TurretSessionHandle = {
	stop: () => Promise<void>;
};

type RecordingOptions = {
	flushMs?: number;
	maxEvents?: number;
	maxChunkBytes?: number;
};

function createTurretSession(options?: RecordingOptions): TurretSessionHandle {
	const flushMs = options?.flushMs ?? 2000;
	const maxEvents = options?.maxEvents ?? 200;
	// Leave room for the JSON envelope below the wire limit.
	const maxChunkBytes = Math.min(
		options?.maxChunkBytes ?? REPLAY_CHUNK_TARGET_BYTES,
		REPLAY_CHUNK_TARGET_BYTES
	);

	const sessionController = new AbortController();
	let sessionStopped = false;
	let recordingStopped = false;
	const recordingController = new AbortController();
	let uploadToken: string | null = null;
	let sessionId: string | null = null;
	let expiresAt: number | null = null;
	let expiryTimer: number | null = null;
	let rrwebStop: listenerHandler | undefined;

	let seq = 0;
	let buffer: eventWithTime[] = [];
	let bufferBytes = 0;
	let bufferStartTs = Date.now();
	let flushTimer: number | null = null;
	let flushing: Promise<void> | null = null;

	function scheduleFlush() {
		if (!canRecord()) return;
		if (flushTimer != null) return;
		flushTimer = window.setTimeout(() => {
			flushTimer = null;
			void flush().catch(captureFailure);
		}, flushMs);
	}

	async function flush() {
		if (!canRecord()) return;
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
			signal: recordingController.signal,
		})
			.then(() => {
				seq += 1;
			})
			.catch((error: unknown) => {
				// The acknowledgement may have been lost after commit. Never replace
				// this sequence with a new batch or continue a replay with missing events.
				failRecording("replay_upload_failed", error);
			})
			.finally(() => {
				flushing = null;
				if (buffer.length) scheduleFlush();
			});

		return flushing;
	}

	function onEmit(ev: eventWithTime) {
		if (!canRecord()) return;
		// Count UTF-8 event bytes and array delimiters without serializing the entire buffer.
		let eventBytes: number;
		try {
			eventBytes = jsonBytes(ev) + 1;
		} catch (error) {
			failRecording("replay_serialization_failed", error);
			return;
		}
		if (
			eventBytes > maxChunkBytes ||
			(flushing && bufferBytes + eventBytes > maxChunkBytes)
		) {
			failRecording(
				"replay_payload_limit",
				new Error("Replay capture exceeded its bounded upload buffer.")
			);
			return;
		}
		if (buffer.length && bufferBytes + eventBytes > maxChunkBytes)
			void flush().catch(captureFailure);
		bufferBytes += eventBytes;

		buffer.push(ev);
		if (typeof ev.timestamp === "number") {
			if (sessionId) setLastRrwebTsMs(sessionId, ev.timestamp);
		}
		if (buffer.length === 1) {
			bufferStartTs = Date.now();
		}

		if (bufferBytes >= maxChunkBytes || buffer.length >= maxEvents) {
			void flush().catch(captureFailure);
			return;
		}

		scheduleFlush();
	}

	async function init() {
		const journeyId = getOrCreateJourneyId();
		const initRes = await turretInitReplaySession({
			journeyId,
			initialUrl: window.location.origin + window.location.pathname,
			signal: sessionController.signal,
		});
		if (sessionStopped || recordingStopped) return;
		sessionId = initRes.session_id;
		uploadToken = initRes.upload_token;
		expiresAt = initRes.upload_expires_at;
		if (!canRecord()) return;
		expiryTimer = window.setTimeout(
			endSession,
			Math.max(0, expiresAt - Date.now())
		);
		// Session-linked errors and feedback remain available if recording cannot start.
		setTurretContext({ sessionId, uploadToken, expiresAt });

		// Loading can fail before the recorder is available (for example, a blocker).
		let rrweb: typeof import("./replay");
		try {
			rrweb = await import("@/react-app/features/turret/replay");
		} catch (error) {
			failRecording("rrweb_blocked_by_client", error);
			return;
		}
		if (!canRecord()) return;

		try {
			const plugins: ReturnType<typeof rrweb.getRecordConsolePlugin>[] =
				[];
			if (initRes.console?.enabled) {
				plugins.push(
					rrweb.getRecordConsolePlugin({
						level: initRes.console.level,
						lengthThreshold: initRes.console.lengthThreshold,
						stringifyOptions: initRes.console.stringifyOptions,
						logger: "console",
					})
				);
			}

			rrwebStop = rrweb.record({
				// Compliance defaults come from the server; callbacks belong to capture.
				...(initRes.rrweb ?? {}),
				emit: onEmit,
				plugins,
			});
			if (sessionStopped || recordingStopped) {
				rrwebStop?.();
				return;
			}
		} catch (error) {
			failRecording("rrweb_initialization_failed", error);
			return;
		}

		// Flush on backgrounding.
		const flushOnHide = () => {
			if (document.visibilityState === "hidden")
				void flush().catch(captureFailure);
		};
		const flushOnPageHide = () => void flush().catch(captureFailure);
		document.addEventListener("visibilitychange", flushOnHide);
		window.addEventListener("pagehide", flushOnPageHide);

		// Also flush periodically.
		scheduleFlush();

		return () => {
			document.removeEventListener("visibilitychange", flushOnHide);
			window.removeEventListener("pagehide", flushOnPageHide);
		};
	}

	let cleanupListeners: (() => void) | undefined;
	function captureFailure(error: unknown) {
		if (!sessionStopped && import.meta.env.DEV)
			console.warn("Turret recording failed", error);
	}

	// Fire async init, but never throw to the caller.
	void (async () => {
		try {
			const cleanup = await init();
			if (sessionStopped || recordingStopped) cleanup?.();
			else cleanupListeners = cleanup;
		} catch (err) {
			// Common causes:
			// - missing TURRET_SIGNING_KEY -> 500
			// - APP_URL origin mismatch -> 403
			captureFailure(err);
		}
	})();

	// Every capture failure stops replay before reporting it. Keep the session's
	// error/feedback credentials until expiry, unless the server rejects them.
	function failRecording(reason: TurretBlockedReason, error: unknown) {
		if (sessionStopped || recordingStopped) return;
		stopRecording();
		captureFailure(error);
		if (error instanceof ApiError && error.status === 401) {
			endSession();
			return;
		}
		if (sessionId && uploadToken)
			void turretMarkCaptureBlocked({
				sessionId,
				uploadToken,
				reason,
				message: error instanceof Error ? error.message : String(error),
			}).catch(captureFailure);
	}

	function stopRecording() {
		if (recordingStopped) return;
		recordingStopped = true;
		recordingController.abort();
		cleanupListeners?.();
		if (sessionId) setLastRrwebTsMs(sessionId, null);
		cleanupListeners = undefined;
		if (flushTimer != null) {
			window.clearTimeout(flushTimer);
			flushTimer = null;
		}
		// Stop synchronously on identity changes. Never upload another user's screen.
		try {
			rrwebStop?.();
		} catch (error) {
			if (import.meta.env.DEV)
				console.warn("Turret recorder failed to stop", error);
		}
		buffer = [];
		bufferBytes = 0;
	}
	function canRecord() {
		if (expiresAt !== null && Date.now() >= expiresAt) endSession();
		return !sessionStopped && !recordingStopped;
	}
	function endSession() {
		if (sessionStopped) return;
		sessionStopped = true;
		sessionController.abort();
		stopRecording();
		if (expiryTimer !== null) window.clearTimeout(expiryTimer);
		expiryTimer = null;
		if (sessionId) clearTurretContext(sessionId);
	}
	return { stop: async () => endSession() };
}

export { createTurretSession };
