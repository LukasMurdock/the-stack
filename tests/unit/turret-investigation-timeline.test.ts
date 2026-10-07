import assert from "node:assert/strict";
import test from "node:test";
import {
	NEARBY_AFTER_MS,
	NEARBY_BEFORE_MS,
	buildInvestigationTimeline,
	formatOffset,
	nearbyWindow,
} from "../../src/react-app/features/turret/investigation/timeline";

const consoleAt = (timestamp: number) => ({
	timestamp,
	level: "error",
	payload: [],
	trace: [],
});

test("investigation timelines order evidence causally and honor half-open windows", () => {
	const occurrence = 1_000_000;
	const window = nearbyWindow(occurrence);
	const entries = buildInvestigationTimeline({
		errors: [
			{ id: "error", ts: new Date(occurrence).toISOString() },
			{ id: "too-late", ts: occurrence + NEARBY_AFTER_MS },
		],
		feedback: [{ id: "report", ts: occurrence }],
		requests: [
			{ id: "request", ts: new Date(occurrence).toISOString() },
			{ id: "earliest", ts: occurrence - NEARBY_BEFORE_MS },
			{ id: "unparseable", ts: "not a date" },
		],
		console: [consoleAt(occurrence)],
		window,
	});
	assert.deepEqual(
		entries.map((entry) => entry.key),
		[
			"request:earliest",
			"request:request",
			`console:${occurrence}:0`,
			"error:error",
			"feedback:report",
		]
	);
	const whole = buildInvestigationTimeline({
		errors: [{ id: "too-late", ts: occurrence + NEARBY_AFTER_MS }],
		feedback: [],
		requests: [],
		console: [],
		window: null,
	});
	assert.deepEqual(
		whole.map((entry) => entry.ts),
		[occurrence + NEARBY_AFTER_MS]
	);
});

test("offsets read as signed distances from the occurrence", () => {
	assert.equal(formatOffset(0), "0s");
	assert.equal(formatOffset(-3_250), "−3.3s");
	assert.equal(formatOffset(1_000), "+1.0s");
	assert.equal(formatOffset(-125_000), "−2m 05s");
});
