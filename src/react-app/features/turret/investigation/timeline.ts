import type { ReplayConsoleItem } from "../session/useReplayPlayer";

import {
	TURRET_NEARBY_AFTER_MS,
	TURRET_NEARBY_BEFORE_MS,
	TURRET_REPLAY_LEAD_MS,
} from "../../../../contracts/turret-investigation-export";

// Shared with the investigation export so both describe the same moments.
export const REPLAY_LEAD_MS = TURRET_REPLAY_LEAD_MS;
export const NEARBY_BEFORE_MS = TURRET_NEARBY_BEFORE_MS;
export const NEARBY_AFTER_MS = TURRET_NEARBY_AFTER_MS;

type Timed = { id: string; ts: string | number };

// The evidence an investigation centers on: an error occurrence or a report.
export type InvestigationFocus = {
	kind: "error" | "feedback";
	id: string;
	ts: number;
};

export type TimelineEntry<E extends Timed, F extends Timed, R extends Timed> =
	| { kind: "request"; key: string; ts: number; value: R }
	| { kind: "console"; key: string; ts: number; value: ReplayConsoleItem }
	| { kind: "error"; key: string; ts: number; value: E }
	| { kind: "feedback"; key: string; ts: number; value: F };

// At equal timestamps, show causes before effects: a request, then what the
// page logged, then the captured error, then what the user reported.
const kindOrder = { request: 0, console: 1, error: 2, feedback: 3 };

function epochMs(ts: string | number): number {
	return typeof ts === "number" ? ts : new Date(ts).getTime();
}

export function nearbyWindow(occurrenceTs: number) {
	return {
		from: occurrenceTs - NEARBY_BEFORE_MS,
		to: occurrenceTs + NEARBY_AFTER_MS,
	};
}

// Merges replay-session evidence into one chronological list. Like other Turret
// ranges, a window includes from and excludes to.
export function buildInvestigationTimeline<
	E extends Timed,
	F extends Timed,
	R extends Timed,
>(input: {
	errors: E[];
	feedback: F[];
	requests: R[];
	console: ReplayConsoleItem[];
	window: { from: number; to: number } | null;
}): TimelineEntry<E, F, R>[] {
	const entries: TimelineEntry<E, F, R>[] = [
		...input.requests.map((value) => ({
			kind: "request" as const,
			key: `request:${value.id}`,
			ts: epochMs(value.ts),
			value,
		})),
		...input.console.map((value, index) => ({
			kind: "console" as const,
			key: `console:${value.timestamp}:${index}`,
			ts: value.timestamp,
			value,
		})),
		...input.errors.map((value) => ({
			kind: "error" as const,
			key: `error:${value.id}`,
			ts: epochMs(value.ts),
			value,
		})),
		...input.feedback.map((value) => ({
			kind: "feedback" as const,
			key: `feedback:${value.id}`,
			ts: epochMs(value.ts),
			value,
		})),
	];
	const window = input.window;
	return entries
		.filter(
			(entry) =>
				Number.isFinite(entry.ts) &&
				(!window || (entry.ts >= window.from && entry.ts < window.to))
		)
		.sort((a, b) => a.ts - b.ts || kindOrder[a.kind] - kindOrder[b.kind]);
}

// Formats an entry's time relative to the occurrence under investigation.
export function formatOffset(ms: number): string {
	if (ms === 0) return "0s";
	const sign = ms < 0 ? "−" : "+";
	const abs = Math.abs(ms);
	if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
	const minutes = Math.floor(abs / 60_000);
	const seconds = Math.floor((abs % 60_000) / 1000);
	return `${sign}${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
