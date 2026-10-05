import { readSqlRow } from "../helpers/sqlite-d1";
import { z } from "zod";
import { testBindings } from "../helpers/worker";
import { isRecord } from "../../src/lib/isRecord";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";
import worker, { type Bindings } from "../../src/worker/index";
import { observeRequest } from "../../src/worker/observability/request";
import { observePageRequest } from "../../src/worker/observability/page";

function fixture() {
	const sqlite = new Database(":memory:");
	const initial = readFileSync(
		new URL(
			"../../src/bindings/d1/turret/drizzle/0000_numerous_blackheart.sql",
			import.meta.url
		),
		"utf8"
	);
	const breadcrumbs = readFileSync(
		new URL(
			"../../src/bindings/d1/turret/drizzle/0003_sturdy_scorpion.sql",
			import.meta.url
		),
		"utf8"
	);
	for (const [source, table] of [
		[initial, "turret_session_errors"],
		[initial, "turret_sessions"],
		[breadcrumbs, "turret_request_breadcrumbs"],
		[breadcrumbs, "turret_request_spans"],
	]) {
		const definition = source.match(
			new RegExp("CREATE TABLE `" + table + "` \\([\\s\\S]*?\\);")
		);
		assert.ok(definition);
		sqlite.exec(definition[0]);
	}
	sqlite.exec(
		"ALTER TABLE turret_session_errors ADD COLUMN expires_at integer"
	);
	const db = createSqliteD1(sqlite);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../src/bindings/d1/core/drizzle/0001_auth-secondary-storage.sql",
				import.meta.url
			),
			"utf8"
		)
	);
	const background: Promise<unknown>[] = [];
	const spans: {
		name: string;
		attributes: Record<string, unknown>;
		errors: unknown[];
	}[] = [];
	class TestSpan implements Span {
		readonly isTraced = true;
		readonly record: (typeof spans)[number];
		constructor(name = "unnamed") {
			this.record = { name, attributes: {}, errors: [] };
			spans.push(this.record);
		}
		setAttribute(key: string, value: boolean | number | string) {
			this.record.attributes[key] = value;
			return this;
		}
		setAttributes(attributes: Parameters<Span["setAttributes"]>[0]) {
			Object.assign(this.record.attributes, attributes);
			return this;
		}
		recordException(error: Parameters<Span["recordException"]>[0]) {
			this.record.errors.push(error);
		}
		updateName(name: string) {
			this.record.name = name;
			return this;
		}
		setStatus(_status: TracingSpanStatus) {
			return this;
		}
		end() {}
	}
	const tracing: Tracing = {
		enterSpan<T, A extends unknown[]>(
			name: string,
			operation: (span: Span, ...args: A) => T,
			...args: A
		): T {
			return operation(new TestSpan(name), ...args);
		},
		startActiveSpan<T, A extends unknown[]>(
			name: string,
			operation: (span: Span, ...args: A) => T,
			...args: A
		): T {
			return operation(new TestSpan(name), ...args);
		},
		startSpan: (name) => new TestSpan(name),
		getActiveSpan: () => undefined,
		Span: TestSpan,
	};
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			background.push(promise);
		},
		passThroughOnException() {},
		abort(reason?: unknown) {
			throw reason;
		},
		props: {},
		tracing,
	};
	const env = testBindings({
		APP_ENV: "local",
		APP_URL: "http://localhost:4321",
		TURRET_MODE: "off",
		TURRET_DB: db,
		CORE_DB: db,
		CF_VERSION_METADATA: { id: "version-1", tag: "", timestamp: "" },
	});
	return {
		sqlite,
		db,
		env,
		ctx,
		spans,
		background,
		async flush() {
			await Promise.all(background);
		},
	};
}

function captureLogs(t: TestContext) {
	const logs: unknown[][] = [];
	for (const level of ["log", "info", "warn", "error"] as const)
		t.mock.method(console, level, (...args: unknown[]) => {
			logs.push(args);
		});
	return logs;
}

function wideEvents(logs: unknown[][]): Record<string, unknown>[] {
	return logs
		.flat()
		.filter(
			(value): value is Record<string, unknown> =>
				typeof value === "object" && value !== null && "action" in value
		);
}

test("operational metrics survive broken replay storage and cover excluded routes once", async (t) => {
	captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const points: { blobs: string[]; doubles: number[]; indexes: string[] }[] =
		[];
	f.env.TURRET_METRICS = {
		writeDataPoint(point) {
			points.push(
				z
					.object({
						blobs: z.array(z.string()),
						doubles: z.array(z.number()),
						indexes: z.array(z.string()),
					})
					.parse(point)
			);
		},
	};
	f.sqlite.exec("DROP TABLE turret_request_breadcrumbs");
	for (const path of [
		"/api/missing",
		"/api/turret/missing",
		"/api/internal/missing",
		"/api/health",
	]) {
		const response = await worker.fetch(
			new Request(`http://localhost:4321${path}?token=secret`),
			f.env,
			f.ctx
		);
		assert.notEqual(response.status, 500);
	}
	// Use middleware directly to isolate auth-category capture from auth's database setup.
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.get("/api/auth/example", (c) => c.json({ ok: true }));
	await app.fetch(
		new Request("http://localhost:4321/api/auth/example"),
		{ ...f.env },
		f.ctx
	);
	await f.flush();
	assert.equal(points.length, 5);
	assert.deepEqual(
		points.map((point) => point.blobs[6]),
		["application", "ingest", "admin", "health", "auth"]
	);
	assert.ok(
		points.every(
			(point) => point.blobs[0] === "v1" && point.doubles[4] === 1
		)
	);
	assert.ok(!JSON.stringify(points).includes("secret"));
});

test("a failing metrics binding leaves the response and request correlation intact", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	f.env.TURRET_METRICS = {
		writeDataPoint() {
			throw new Error("metrics unavailable");
		},
	};
	const response = await worker.fetch(
		new Request("http://localhost:4321/api/health"),
		f.env,
		f.ctx
	);
	assert.equal(response.status, 200);
	assert.ok(response.headers.get("x-request-id"));
	assert.equal(
		wideEvents(logs).filter(
			(event) => event.action === "observability.metrics_failed"
		).length,
		1
	);
});

test("Astro boundary preserves response streams and logs thrown errors with safe correlation", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const points: { blobs: string[]; doubles: number[] }[] = [];
	f.env.TURRET_METRICS = {
		writeDataPoint(point) {
			points.push(
				z
					.object({
						blobs: z.array(z.string()),
						doubles: z.array(z.number()),
						indexes: z.array(z.string()),
					})
					.parse(point)
			);
		},
	};
	const request = new Request(
		"http://localhost:4321/private/customer-email?token=secret",
		{
			headers: { "x-request-id": "page-1", "cf-ray": "ray-1" },
		}
	);
	const response = await observePageRequest(
		request,
		f.env,
		f.ctx,
		async () =>
			new Response("page body", {
				status: 201,
				headers: { "content-type": "text/plain" },
			})
	);
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("x-request-id"), "page-1");
	assert.equal(await response.text(), "page body");
	assert.equal(response.headers.get("content-type"), "text/plain");
	const error = new Error("render failed");
	await assert.rejects(
		observePageRequest(request, f.env, f.ctx, async () => {
			throw error;
		}),
		(actual) => actual === error
	);
	const events = wideEvents(logs).filter(
		(event) => event.action === "page.request"
	);
	assert.equal(events.length, 2);
	assert.equal(events[0].requestId, "page-1");
	assert.equal(events[1].status, 500);
	assert.equal(f.spans[1].errors[0], error);
	assert.equal(points.length, 2);
	assert.equal(points[1].doubles[2], 1);
	assert.ok(!JSON.stringify(events).includes("customer-email"));
	assert.ok(!JSON.stringify(events).includes("token=secret"));
});

test("Worker exceptions keep their stack, fingerprint and correlation without a duplicate 5xx", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const sessionId = "fd6b3e90-1e48-4aa7-8e08-62afed799610";
	const now = Date.now();
	f.sqlite
		.prepare(
			"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
		)
		.run(sessionId, now, "user-1", "policy-1", now + 3600000, now, now);
	const response = await worker.fetch(
		new Request("http://localhost:4321/api/throw?token=secret", {
			headers: {
				"x-request-id": "request-1",
				"x-turret-session-id": sessionId,
			},
		}),
		f.env,
		f.ctx
	);
	assert.equal(response.status, 500);
	assert.equal(response.headers.get("x-request-id"), "request-1");
	await f.flush();
	const rows = f.sqlite
		.prepare<unknown[], Record<string, unknown>>(
			"SELECT * FROM turret_session_errors"
		)
		.all();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].session_id, sessionId);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT error_count FROM turret_sessions")
			.error_count,
		1
	);
	assert.equal(rows[0].message, "Intentional test error");
	assert.match(String(rows[0].stack), /root\.ts/);
	const extra = JSON.parse(String(rows[0].extra_json));
	assert.equal(extra.kind, "exception");
	assert.equal(extra.request_id, "request-1");
	assert.equal(extra.worker_version, "version-1");
	assert.match(String(rows[0].fingerprint), /^v1:/);
	assert.ok(!JSON.stringify(rows).includes("token=secret"));
	const event = wideEvents(logs).find(
		(event) => event.action === "api.request"
	);
	assert.equal(
		isRecord(event?.error) ? event.error.kind : undefined,
		"exception"
	);
	assert.equal(f.spans[0].attributes["request.id"], "request-1");
	assert.equal(f.spans[0].errors.length, 1);
	assert.equal(f.env.CORE_DB, f.db);
});

test("Returned 5xx, ingestion failures and CORS rejections all emit structured events", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	for (const request of [
		new Request("http://localhost:4321/api/fail"),
		new Request("http://localhost:4321/api/turret/replay-session/init", {
			method: "POST",
		}),
		new Request("http://localhost:4321/api/health", {
			headers: { origin: "https://external.example" },
		}),
	]) {
		const response = await worker.fetch(request, f.env, f.ctx);
		assert.ok(response.headers.get("x-request-id"));
	}
	await f.flush();
	const events = wideEvents(logs).filter(
		(event) => event.action === "api.request"
	);
	assert.deepEqual(
		events.map((event) => event.status),
		[500, 503, 403]
	);
	assert.equal(
		isRecord(events[0].error) ? events[0].error.kind : undefined,
		"http_5xx"
	);
	assert.equal(events[2].error, undefined);
	assert.equal(f.spans[1].name, "turret.ingest");
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_session_errors")
			.n,
		1
	);
});

test("D1 replay spans are bounded, inserted within D1 limits, and exclude telemetry writes", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.get("/api/example", async (c) => {
		for (let i = 0; i < 105; i++)
			await c.env.CORE_DB.prepare("SELECT ? AS value").bind(i).all();
		return c.json({ ok: true });
	});
	const response = await app.fetch(
		new Request("http://localhost:4321/api/example"),
		{ ...f.env },
		f.ctx
	);
	assert.equal(response.status, 200);
	await f.flush();
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_request_spans")
			.n,
		100
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT d1_queries_count AS n FROM turret_request_breadcrumbs"
		).n,
		105
	);
	const event = wideEvents(logs).find(
		(event) => event.action === "api.request"
	);
	assert.equal(isRecord(event?.d1) ? event.d1.droppedSpans : undefined, 5);
	assert.equal(f.env.CORE_DB, f.db);
});

test("Cleanup emits completion, preserves failure, and never masks scheduled errors", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	await worker.scheduled(
		{ cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} },
		f.env,
		f.ctx
	);
	f.sqlite.exec("DROP TABLE turret_request_spans");
	await assert.rejects(
		worker.scheduled(
			{ cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} },
			f.env,
			f.ctx
		),
		/Failed query/
	);
	const events = wideEvents(logs).filter(
		(event) => event.action === "turret.cleanup"
	);
	assert.equal(events.length, 2);
	assert.ok(events[1].error);
	assert.equal(f.spans[1].errors.length, 1);
});

test("Concurrent requests isolate shared bindings and replace invalid request IDs", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const requests = ["one", "two"].map(
		(path) =>
			new Request(`http://localhost:4321/api/missing/${path}`, {
				headers: { "x-request-id": "invalid id" },
			})
	);
	const responses = await Promise.all(
		requests.map((request) => worker.fetch(request, f.env, f.ctx))
	);
	await f.flush();
	assert.equal(f.env.CORE_DB, f.db);
	assert.equal(f.env.TURRET_DB, f.db);
	const ids = responses.map((response) =>
		response.headers.get("x-request-id")
	);
	assert.equal(new Set(ids).size, 2);
	for (const id of ids) assert.match(id ?? "", /^[0-9a-f-]{36}$/);
	const events = wideEvents(logs).filter(
		(event) => event.action === "api.request"
	);
	assert.equal(events.length, 2);
	assert.ok(
		events.every((event) => isRecord(event.d1) && event.d1.queries === 0)
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT count(*) AS n FROM turret_request_breadcrumbs"
		).n,
		2
	);
});
