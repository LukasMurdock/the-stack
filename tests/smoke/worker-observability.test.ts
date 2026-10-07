import { testRouteLabel } from "../helpers/route-label";
import { fingerprintHttp5xx } from "../../src/worker/turret/fingerprinting";
import { recordWorkerError } from "../../src/worker/observability/turret";
import { fingerprintException } from "../../src/worker/turret/fingerprinting";
import { readSqlRow } from "../helpers/sqlite-d1";
import { z } from "zod";
import { testBindings } from "../helpers/worker";
import { isRecord } from "../../src/lib/isRecord";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { migratedSqlite } from "../helpers/migrations";
import { Hono } from "hono";
import worker, { type Bindings } from "../../src/worker/index";
import { observeRequest } from "../../src/worker/observability/request";
import { observePageRequest } from "../../src/worker/observability/page";

function fixture() {
	const sqlite = migratedSqlite("core", "turret");
	const db = createSqliteD1(sqlite);
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
	assert.equal(rows[0].expires_at, now + 3600000);
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

test("failed span persistence keeps its breadcrumb and never fails the application response", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	f.sqlite
		.exec(`CREATE TRIGGER reject_spans BEFORE INSERT ON turret_request_spans
		BEGIN SELECT RAISE(ABORT, 'Span storage unavailable'); END;`);
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.get("/api/example", async (c) => {
		await c.env.CORE_DB.prepare("SELECT 1 AS value").all();
		return c.json({ ok: true });
	});
	const response = await app.fetch(
		new Request("http://localhost:4321/api/example"),
		f.env,
		f.ctx
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	await f.flush();
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_request_spans")
			.n,
		0
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT d1_queries_count AS n FROM turret_request_breadcrumbs"
		).n,
		1
	);
	assert.ok(
		wideEvents(logs).some(
			(event) => event.action === "turret.breadcrumb_failed"
		)
	);
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

test("correlation is decoded once and invalid timestamps cannot discard errors or breadcrumbs", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.get("/api/example-error", (c) => {
		// Downstream header mutation must not change the correlation snapshot taken at entry.
		c.req.raw.headers.set("x-turret-replay-ts", "999");
		return c.json({ error: "failed" }, 500);
	});
	for (const [index, value] of [
		undefined,
		"",
		"NaN",
		"Infinity",
		"1e100",
		"8640000000000001",
		"-1",
		"1.5",
		"1000",
		"0",
	].entries()) {
		const requestId = `correlation-${index}`;
		const before = Date.now();
		const response = await app.fetch(
			new Request("http://localhost:4321/api/example-error", {
				headers: {
					"x-request-id": requestId,
					"x-turret-session-id": "session",
					...(value === undefined
						? {}
						: { "x-turret-replay-ts": value }),
				},
			}),
			{ ...f.env },
			f.ctx
		);
		assert.equal(response.status, 500);
		await f.flush();
		const error = f.sqlite
			.prepare(
				"SELECT ts, session_id FROM turret_session_errors WHERE json_extract(extra_json, '$.request_id') = ?"
			)
			.get(requestId);
		assert.ok(isRecord(error));
		const breadcrumb = f.sqlite
			.prepare(
				"SELECT ts, session_id FROM turret_request_breadcrumbs WHERE request_id = ?"
			)
			.get(requestId);
		assert.ok(isRecord(breadcrumb));
		assert.equal(error.ts, breadcrumb.ts);
		assert.equal(error.session_id, "session");
		assert.equal(breadcrumb.session_id, "session");
		if (value === "1000" || value === "0")
			assert.equal(error.ts, Number(value));
		else
			assert.ok(
				Number(error.ts) >= before && Number(error.ts) <= Date.now()
			);
	}
	assert.ok(!JSON.stringify(logs).includes("turret.error_capture_failed"));
});

test("worker capture bounds stored diagnostics without changing fingerprint input", async (t) => {
	const f = fixture();
	t.after(() => f.sqlite.close());
	// Leading whitespace puts meaningful fingerprint input beyond the storage limits.
	const error = new Error(" ".repeat(2000) + "failure");
	error.stack = " ".repeat(20000) + "at example()";
	await recordWorkerError({
		pathTemplate: testRouteLabel("/api/example"),
		env: f.env,
		request: new Request("http://localhost:4321/api/example"),
		requestId: "long-error",
		correlation: { sessionId: null, replayTs: null, ts: 0 },
		kind: "exception",
		error,
	});
	const row = readSqlRow(
		f.sqlite,
		"SELECT ts, message, stack, fingerprint FROM turret_session_errors"
	);
	assert.equal(row.ts, 0);
	assert.equal(row.message, " ".repeat(2000));
	assert.equal(row.stack, " ".repeat(20000));
	assert.equal(
		row.fingerprint,
		await fingerprintException({
			platform: "worker",
			message: error.message,
			stack: error.stack,
			method: "GET",
			pathTemplate: "/api/example",
		})
	);
});

test("request policy keeps metrics, trace names, breadcrumbs, and errors distinct", async (t) => {
	captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const categories: string[] = [];
	f.env.TURRET_METRICS = {
		writeDataPoint(point) {
			categories.push(
				z
					.string()
					.parse(
						z.object({ blobs: z.array(z.string()) }).parse(point)
							.blobs[6]
					)
			);
		},
	};
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.all("*", (c) => c.json({ error: "Expected failure" }, 500));
	for (const [path, category, spanName, breadcrumb, error] of [
		["/api/projects", "application", "api.request", true, true],
		["/api/auth/get-session", "auth", "auth.request", false, true],
		["/api/internal/turret/issues", "admin", "turret.admin", false, false],
		["/api/internal/example", "admin", "api.request", true, true],
		[
			"/api/turret/replay-session/session/error",
			"ingest",
			"turret.ingest",
			false,
			false,
		],
		[
			"/api/turret/session/session/chunk",
			"ingest",
			"turret.ingest",
			false,
			false,
		],
		["/api/turret/other", "ingest", "turret.ingest", false, true],
		["/api/turret/replay-session", "ingest", "turret.ingest", false, true],
		["/api/health", "health", "api.request", false, true],
		["/api/doc", "application", "api.request", false, true],
		["/api/scalar", "application", "api.request", false, true],
		["/api/throw", "application", "api.request", false, true],
		["/api/fail", "application", "api.request", false, true],
		["/api/health/example", "application", "api.request", true, true],
		["/api/authentication", "application", "api.request", true, true],
		["/api/internal/turretish/example", "admin", "api.request", true, true],
		["/outside", "application", "api.request", false, false],
	] as const) {
		const beforeErrors = f.sqlite
			.prepare("SELECT count(*) FROM turret_session_errors")
			.pluck()
			.get();
		const beforeBreadcrumbs = f.sqlite
			.prepare("SELECT count(*) FROM turret_request_breadcrumbs")
			.pluck()
			.get();
		const beforeSpans = f.spans.length;
		const response = await app.fetch(
			new Request(`http://localhost:4321${path}`),
			{ ...f.env },
			f.ctx
		);
		assert.equal(response.status, 500);
		await f.flush();
		assert.equal(categories.at(-1), category, path);
		assert.equal(f.spans[beforeSpans].name, spanName, path);
		assert.equal(
			f.sqlite
				.prepare("SELECT count(*) FROM turret_session_errors")
				.pluck()
				.get(),
			Number(beforeErrors) + Number(error),
			path
		);
		assert.equal(
			f.sqlite
				.prepare("SELECT count(*) FROM turret_request_breadcrumbs")
				.pluck()
				.get(),
			Number(beforeBreadcrumbs) + Number(breadcrumb),
			path
		);
	}
});

test("declared route labels group resource IDs and bound unmatched paths across telemetry", async (t) => {
	const logs = captureLogs(t);
	const f = fixture();
	t.after(() => f.sqlite.close());
	const labels: string[] = [];
	f.env.TURRET_METRICS = {
		writeDataPoint(point) {
			labels.push(z.string().parse(point?.blobs?.[5]));
		},
	};
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.get("/api/organizations/:organizationId/projects", (c) =>
		c.json({ error: "failure" }, 500)
	);
	app.get("/api/auth/*", (c) => c.json({ ok: true }));
	for (const path of [
		"/api/organizations/550e8400-e29b-41d4-a716-446655440000/projects?token=secret",
		"/api/organizations/12345678-1234-4123-8123-123456789012/projects",
		"/api/unmatched/private-user-id",
		"/api/auth/reset-password/private-token",
	])
		await app.fetch(
			new Request(`http://localhost:4321${path}`),
			{ ...f.env },
			f.ctx
		);
	await f.flush();
	assert.deepEqual(labels, [
		"/api/organizations/:organizationId/projects",
		"/api/organizations/:organizationId/projects",
		"/api/*",
		"/api/auth/*",
	]);
	const errors = z
		.array(z.object({ fingerprint: z.string(), extra_json: z.string() }))
		.parse(
			f.sqlite
				.prepare(
					"SELECT fingerprint, extra_json FROM turret_session_errors ORDER BY created_at"
				)
				.all()
		);
	assert.equal(errors.length, 2);
	assert.equal(errors[0].fingerprint, errors[1].fingerprint);
	assert.equal(
		errors[0].fingerprint,
		await fingerprintHttp5xx({
			method: "GET",
			pathTemplate: testRouteLabel(labels[0]),
			status: 500,
		})
	);
	assert.deepEqual(
		f.spans.map((span) => span.attributes["http.route"]),
		labels
	);
	const events = wideEvents(logs).filter(
		(event) => event.action === "api.request"
	);
	assert.deepEqual(
		events.map((event) =>
			isRecord(event.route) ? event.route.pathTemplate : null
		),
		labels
	);
	assert.ok(!JSON.stringify(errors).includes("550e8400"));
	assert.ok(!JSON.stringify(errors).includes("token=secret"));
});
