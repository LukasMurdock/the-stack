import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackendHealthSection } from "../../src/react-app/features/turret/dashboard/BackendHealthSection";
import { LastHourReplayCard } from "../../src/react-app/features/turret/dashboard/ReplayTotals";

const totals = {
	requests: 1250,
	serverErrors: 12,
	slowRequests: 38,
	avgDurationMs: 112,
	p95DurationMs: 845,
};
const data = {
	from: 7_000_000,
	to: 10_600_000,
	replay: {
		state: "ready",
		totals: {
			replaySessions: 25,
			errorReplaySessions: 12,
			captureBlocked: 4,
		},
	},
	operations: {
		state: "ready",
		totals,
		routes: [
			{
				...totals,
				surface: "api",
				method: "GET",
				route: "/api/example/:id",
				category: "application",
				version: "release-12345678",
			},
		],
	},
};

function query(value: unknown, error = false) {
	return {
		data: value,
		isError: error,
		isFetching: false,
		isRefetchError: false,
		dataUpdatedAt: 10_600_000,
		refetch: async () => ({}),
	} as never;
}

test("dashboard renders full replay totals and sampled request health with release context", () => {
	const replay = renderToStaticMarkup(
		createElement(LastHourReplayCard, { query: query(data) })
	);
	assert.match(replay, />25</);
	assert.match(replay, /Error replay sessions/);
	assert.match(replay, />12</);
	const health = renderToStaticMarkup(
		createElement(BackendHealthSection, { query: query(data) })
	);
	assert.match(health, /Sampled estimates/);
	assert.match(health, /1,250/);
	assert.match(health, /845 ms/);
	assert.match(health, /112 ms/);
	assert.match(health, /release-12345678/);
	assert.match(health, /\/api\/example\/:id/);
});

test("missing and failed telemetry render unavailable, while loading is distinct", () => {
	const failed = {
		...data,
		operations: { state: "unavailable", reason: "query_failed" },
		replay: { state: "unavailable" },
	};
	const health = renderToStaticMarkup(
		createElement(BackendHealthSection, { query: query(failed) })
	);
	assert.match(health, /Unavailable/);
	assert.doesNotMatch(health, /1,250/);
	const replay = renderToStaticMarkup(
		createElement(LastHourReplayCard, { query: query(failed) })
	);
	assert.match(replay, /Unavailable/);
	assert.doesNotMatch(replay, />0</);
	const loading = renderToStaticMarkup(
		createElement(BackendHealthSection, { query: query(undefined) })
	);
	assert.match(loading, /Loading backend health/);
	const error = renderToStaticMarkup(
		createElement(BackendHealthSection, { query: query(undefined, true) })
	);
	assert.match(error, /Retry/);
});
