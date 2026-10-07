import { recordOperation } from "../../src/worker/observability/metrics";
import { testBindings, unavailableD1 } from "../helpers/worker";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { routes } from "../../src/worker/api/routes/internal-turret-summary";
import {
	loadTurretSummary,
	type AnalyticsSqlBinding,
} from "../../src/worker/observability/summary";

test("operational metrics retain the persisted v1 layout", () => {
	// These literal positions describe historical data, independently of the encoder's layout declaration.
	const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] =
		[];
	for (const [status, durationMs] of [
		[503, 125],
		[200, 1500],
	]) {
		recordOperation({
			env: {
				APP_ENV: "production",
				CF_VERSION_METADATA: { id: "release-1" },
				TURRET_METRICS: {
					writeDataPoint: (point) => {
						points.push(point);
					},
				},
			},
			requestId: "request-1",
			surface: "api",
			method: "GET",
			route: "/api/example/:id",
			category: "application",
			colo: "IAD",
			status,
			durationMs,
		});
	}
	assert.deepEqual(points, [
		{
			indexes: ["production"],
			blobs: [
				"v1",
				"production",
				"release-1",
				"api",
				"GET",
				"/api/example/:id",
				"application",
				"IAD",
			],
			doubles: [125, 503, 1, 0, 1],
		},
		{
			indexes: ["production"],
			blobs: [
				"v1",
				"production",
				"release-1",
				"api",
				"GET",
				"/api/example/:id",
				"application",
				"IAD",
			],
			doubles: [1500, 200, 0, 1, 1],
		},
	]);
});

function replayDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec(
		`CREATE TABLE turret_sessions (started_at INTEGER, has_error INTEGER, capture_blocked INTEGER)`
	);
	const db = createSqliteD1(sqlite);
	return { sqlite, db };
}

test("hourly replay totals include all sessions and use half-open boundaries", async (t) => {
	const { sqlite, db } = replayDb();
	t.after(() => sqlite.close());
	const now = 8_000_000;
	const to = Math.floor(now / 60_000) * 60_000;
	const from = to - 3_600_000;
	const insert = sqlite.prepare(
		"INSERT INTO turret_sessions VALUES (?, ?, ?)"
	);
	for (let i = 0; i < 25; i++)
		insert.run(from + i, i < 12 ? 1 : 0, i < 4 ? 1 : 0);
	insert.run(from - 1, 1, 1);
	insert.run(to, 1, 1);
	const result = await loadTurretSummary({ TURRET_DB: db }, now);
	assert.deepEqual(result.replay, {
		state: "ready",
		totals: {
			replaySessions: 25,
			errorReplaySessions: 12,
			captureBlocked: 4,
		},
	});
	assert.equal(result.from, from);
	assert.equal(result.to, to);
	sqlite.exec("DELETE FROM turret_sessions");
	assert.deepEqual((await loadTurretSummary({ TURRET_DB: db }, now)).replay, {
		state: "ready",
		totals: {
			replaySessions: 0,
			errorReplaySessions: 0,
			captureBlocked: 0,
		},
	});
});

test("operational queries are fixed, bounded, parameterized and coalesced", async () => {
	const calls: { query: string; params: Record<string, string | number> }[] =
		[];
	const binding: AnalyticsSqlBinding = {
		async query(input: (typeof calls)[number]) {
			calls.push(input);
			const totals = {
				requests: "20",
				serverErrors: "2",
				slowRequests: "3",
				avgDurationMs: 42,
				p95DurationMs: 1100,
			};
			return {
				data: [
					input.query.includes("GROUP BY")
						? {
								...totals,
								surface: "api",
								method: "GET",
								route: "/api/example/:id",
								category: "application",
								version: "release-1",
							}
						: totals,
				],
			};
		},
	};
	const env = { APP_ENV: "production", ANALYTICS_SQL: binding };
	const [one, two] = await Promise.all([
		loadTurretSummary(env, 8_000_000),
		loadTurretSummary(env, 8_000_000),
	]);
	assert.deepEqual(one, two);
	assert.equal(calls.length, 2);
	assert.equal(one.operations.state, "ready");
	if (one.operations.state === "ready") {
		assert.equal(one.operations.totals.requests, 20);
		assert.equal(one.operations.routes.length, 1);
	}
	for (const input of calls) {
		assert.equal(input.params.environment, "production");
		assert.equal(
			Date.parse(String(input.params.end)) -
				Date.parse(String(input.params.start)),
			3_600_000
		);
		assert.match(input.query, /timestamp >= \$start AND timestamp < \$end/);
		assert.match(input.query, /blob7 != 'admin' AND blob7 != 'health'/);
		assert.match(
			input.query,
			/quantileWeighted\(0.95, double1, sampleInterval\)/
		);
	}
	await loadTurretSummary(env, 8_070_000);
	assert.equal(calls.length, 4);
});

test("local, missing and failing analytics never become healthy-looking zero totals", async (t) => {
	t.mock.method(console, "error", () => {});
	let calls = 0;
	const binding: AnalyticsSqlBinding = {
		async query() {
			calls++;
			throw new Error("unavailable");
		},
	};
	assert.deepEqual(
		(await loadTurretSummary({ APP_ENV: "local", ANALYTICS_SQL: binding }))
			.operations,
		{ state: "unavailable", reason: "local_environment" }
	);
	assert.equal(calls, 0);
	assert.deepEqual(
		(await loadTurretSummary({ APP_ENV: "production" })).operations,
		{ state: "unavailable", reason: "not_configured" }
	);
	const result = await loadTurretSummary({
		APP_ENV: "production",
		ANALYTICS_SQL: binding,
	});
	assert.deepEqual(result.operations, {
		state: "unavailable",
		reason: "query_failed",
	});
	assert.deepEqual(result.replay, { state: "unavailable" });
});

test("a stuck analytics query times out without hiding replay counts", async (t) => {
	t.mock.method(console, "error", () => {});
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { sqlite, db } = replayDb();
	t.after(() => sqlite.close());
	const binding: AnalyticsSqlBinding = {
		query() {
			return new Promise(() => {});
		},
	};
	const loading = loadTurretSummary({
		APP_ENV: "production",
		TURRET_DB: db,
		ANALYTICS_SQL: binding,
	});
	t.mock.timers.tick(5000);
	const result = await loading;
	assert.equal(result.replay.state, "ready");
	assert.deepEqual(result.operations, {
		state: "unavailable",
		reason: "query_failed",
	});
});

test("missing aggregate rows are unavailable, while a valid empty window is zero", async (t) => {
	t.mock.method(console, "error", () => {});
	for (const totals of [
		[],
		[{}],
		[
			{
				requests: 0,
				serverErrors: null,
				slowRequests: null,
				avgDurationMs: null,
				p95DurationMs: null,
			},
		],
	]) {
		const binding: AnalyticsSqlBinding = {
			async query(input: { query: string }) {
				return {
					data: input.query.includes("GROUP BY") ? [] : totals,
				};
			},
		};
		const result = await loadTurretSummary({
			APP_ENV: "production",
			ANALYTICS_SQL: binding,
		});
		if (totals[0] && "requests" in totals[0]) {
			assert.deepEqual(result.operations, {
				state: "ready",
				totals: {
					requests: 0,
					serverErrors: 0,
					slowRequests: 0,
					avgDurationMs: null,
					p95DurationMs: null,
				},
				routes: [],
			});
		} else {
			assert.deepEqual(result.operations, {
				state: "unavailable",
				reason: "query_failed",
			});
		}
	}
});

test("unauthenticated summary requests cannot query account telemetry", async () => {
	let queries = 0;
	const response = await routes.fetch(
		new Request("http://local.test/internal/turret/summary"),
		testBindings({
			APP_ENV: "local",
			APP_URL: "http://local.test",
			PRODUCT_NAME: "The Stack",
			EMAIL_FROM: "admin@localhost.test",
			BETTER_AUTH_SECRET:
				"summary-test-secret-with-at-least-32-characters",
			CORE_DB: unavailableD1("unauthenticated request queried D1"),
			ANALYTICS_SQL: {
				query() {
					queries++;
					throw new Error("unauthorized");
				},
			},
		}),
		{ waitUntil() {}, passThroughOnException() {}, props: {} }
	);
	assert.equal(response.status, 401);
	assert.equal(queries, 0);
});
