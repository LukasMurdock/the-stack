import { testRouteLabel } from "../helpers/route-label";
import { recordWorkerError } from "../../src/worker/observability/turret";
import { readSqlRow } from "../helpers/sqlite-d1";
import assert from "node:assert/strict";
import { z } from "zod";
import test, { type TestContext } from "node:test";
import { migratedSqlite } from "../helpers/migrations";
import { api } from "../../src/worker/api";
import { signUploadToken } from "../../src/worker/api/routes/_shared/turret-upload-token";
import { REPLAY_CHUNK_BYTES_MAX } from "../../src/contracts/turret-ingest";
import { turretUploadChunk } from "../../src/react-app/features/turret/ingest";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { testBindings } from "../helpers/worker";

async function ingestFixture(t: TestContext) {
	const sqlite = migratedSqlite("turret");
	t.after(() => sqlite.close());
	const now = Date.now();
	sqlite
		.prepare(
			"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
		)
		.run("session", now, "user", "1", now + 60000, now, now);
	const writes: string[] = [];
	const objects = new Map<string, { json: string; sha256?: string }>();
	const bucket = {
		async put(key: string, value: string, options: R2PutOptions) {
			assert.equal(typeof value, "string");
			assert.ok(
				typeof options?.onlyIf === "object" &&
					"etagDoesNotMatch" in options.onlyIf
			);
			assert.equal(options.onlyIf.etagDoesNotMatch, "*");
			if (objects.has(key)) return null;
			const json = String(value);
			objects.set(key, { json, sha256: options.customMetadata?.sha256 });
			writes.push(json);
			// SAFETY: commitReplayChunk checks only whether conditional put succeeded.
			return { key } as R2Object;
		},
		async get(key: string) {
			const object = objects.get(key);
			if (!object) return null;
			// SAFETY: commitReplayChunk reads checksum metadata or text on this fixture.
			return {
				customMetadata: object.sha256 ? { sha256: object.sha256 } : {},
				text: async () => object.json,
			} as R2ObjectBody;
		},
	};
	const key = "test-upload-signing-key";
	const env = testBindings({
		APP_URL: "http://localhost:4321",
		TURRET_MODE: "full",
		TURRET_SIGNING_KEY: key,
		TURRET_DB: createSqliteD1(sqlite),
		// SAFETY: chunk ingest exercises only the conditional put and checksum read above.
		TURRET_REPLAY_BUCKET: bucket as R2Bucket,
	});
	const token = await signUploadToken(key, {
		sid: "session",
		exp: Date.now() + 60_000,
		pv: "1",
	});
	function request(
		endpoint: string,
		body: string,
		authorization = token,
		contentLength?: string
	) {
		return api.request(
			`http://localhost:4321/turret/replay-session/session/${endpoint}`,
			{
				method: "POST",
				body,
				headers: {
					Origin: env.APP_URL,
					"Content-Type": "application/json",
					Authorization: `Bearer ${authorization}`,
					...(contentLength === undefined
						? {}
						: { "Content-Length": contentLength }),
				},
			},
			env,
			{ waitUntil() {}, passThroughOnException() {}, props: {} }
		);
	}
	return { sqlite, writes, objects, request, env, key };
}

test("replay chunks enforce actual wire bytes before parsing or writing, including missing and false length headers", async (t) => {
	const f = await ingestFixture(t);
	const tooLarge = "x".repeat(REPLAY_CHUNK_BYTES_MAX + 1);
	for (const length of [undefined, "1"]) {
		const response = await f.request("chunk", tooLarge, undefined, length);
		assert.equal(response.status, 413, await response.clone().text());
	}
	assert.equal(f.writes.length, 0);
	assert.equal(
		f.sqlite
			.prepare("select count(*) from turret_session_chunks")
			.pluck()
			.get(),
		0
	);
	const empty = JSON.stringify({ seq: 0, events: [""] });
	const exact = JSON.stringify({
		seq: 0,
		events: ["x".repeat(REPLAY_CHUNK_BYTES_MAX - empty.length)],
	});
	assert.equal(
		new TextEncoder().encode(exact).byteLength,
		REPLAY_CHUNK_BYTES_MAX
	);
	const accepted = await f.request("chunk", exact);
	assert.equal(accepted.status, 200, await accepted.clone().text());
	const unicode = JSON.stringify({ seq: 1, events: ["界".repeat(20)] });
	assert.equal((await f.request("chunk", unicode)).status, 200);
	assert.deepEqual(
		f.sqlite
			.prepare("select size from turret_session_chunks order by seq")
			.pluck()
			.all(),
		[REPLAY_CHUNK_BYTES_MAX, new TextEncoder().encode(unicode).byteLength]
	);
	assert.equal(f.writes.length, 2);
});

test("every upload endpoint enforces mode and session-bound authorization before JSON parsing", async (t) => {
	const f = await ingestFixture(t);
	const wrongSession = await signUploadToken(f.key, {
		sid: "different",
		exp: Date.now() + 60_000,
		pv: "1",
	});
	const expired = await signUploadToken(f.key, {
		sid: "session",
		exp: Date.now() - 1,
		pv: "1",
	});
	for (const endpoint of ["chunk", "blocked", "error", "feedback"]) {
		for (const token of ["", "invalid", wrongSession, expired])
			assert.equal(
				(await f.request(endpoint, "not json", token)).status,
				401,
				endpoint
			);
		f.env.TURRET_MODE = "off";
		assert.equal(
			(await f.request(endpoint, "not json")).status,
			503,
			endpoint
		);
		f.env.TURRET_MODE = "full";
		const key = f.env.TURRET_SIGNING_KEY;
		f.env.TURRET_SIGNING_KEY = "";
		assert.equal(
			(await f.request(endpoint, "not json")).status,
			503,
			endpoint
		);
		f.env.TURRET_SIGNING_KEY = key;
	}
	assert.equal(f.writes.length, 0);
});

test("the client rejects a UTF-8 oversized replay before issuing a request", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () =>
		Response.json({ ok: true })
	);
	await assert.rejects(
		turretUploadChunk({
			sessionId: "session",
			uploadToken: "token",
			seq: 0,
			tsStart: 0,
			tsEnd: 0,
			events: ["界".repeat(Math.ceil(REPLAY_CHUNK_BYTES_MAX / 3))],
		}),
		/byte limit/i
	);
	assert.equal(fetch.mock.callCount(), 0);
});

test("expired or missing sessions reject valid upload tokens before parsing or storage", async (t) => {
	const f = await ingestFixture(t);
	f.sqlite.exec("UPDATE turret_sessions SET retention_expires_at = 0");
	for (const endpoint of ["chunk", "blocked", "error"]) {
		const response = await f.request(endpoint, "not json");
		assert.equal(response.status, 401);
	}
	f.sqlite.exec("DELETE FROM turret_sessions");
	assert.equal((await f.request("chunk", "not json")).status, 401);
	assert.equal(f.writes.length, 0);
});

test("chunk commits are idempotent and reject conflicting content without overwriting R2", async (t) => {
	const f = await ingestFixture(t);
	const chunk = JSON.stringify({
		seq: 0,
		events: [{ timestamp: 123, type: 2, data: {} }],
		ts_start: 123,
		ts_end: 123,
	});
	assert.equal((await f.request("chunk", chunk)).status, 200);
	assert.equal((await f.request("chunk", chunk)).status, 200);
	const changed = JSON.stringify({
		seq: 0,
		events: [{ timestamp: 456, type: 2, data: {} }],
	});
	const conflict = await f.request("chunk", changed);
	assert.equal(conflict.status, 409);
	assert.equal(
		z.object({ code: z.string() }).parse(await conflict.json()).code,
		"chunk_conflict"
	);
	assert.equal(f.writes.length, 1);
	assert.equal(
		f.sqlite
			.prepare("SELECT count(*) FROM turret_session_chunks")
			.pluck()
			.get(),
		1
	);
	const session = f.sqlite
		.prepare(
			"SELECT chunk_count, rrweb_start_ts_ms, rrweb_last_ts_ms FROM turret_sessions"
		)
		.get();
	assert.deepEqual(session, {
		chunk_count: 1,
		rrweb_start_ts_ms: 123,
		rrweb_last_ts_ms: 123,
	});
	assert.equal([...f.objects.values()][0].json, chunk);
});

test("D1 commit failure rolls back metadata and counts; a retry repairs the immutable R2 object", async (t) => {
	const f = await ingestFixture(t);
	f.sqlite.exec(
		"CREATE TRIGGER fail_chunk_count BEFORE UPDATE ON turret_sessions BEGIN SELECT RAISE(ABORT, 'count unavailable'); END"
	);
	const chunk = JSON.stringify({ seq: 0, events: [] });
	assert.equal((await f.request("chunk", chunk)).status, 500);
	assert.equal(f.objects.size, 1);
	assert.equal(
		f.sqlite
			.prepare("SELECT count(*) FROM turret_session_chunks")
			.pluck()
			.get(),
		0
	);
	assert.equal(
		f.sqlite
			.prepare("SELECT chunk_count FROM turret_sessions")
			.pluck()
			.get(),
		0
	);
	f.sqlite.exec("DROP TRIGGER fail_chunk_count");
	assert.equal((await f.request("chunk", chunk)).status, 200);
	assert.equal(f.writes.length, 1);
	assert.equal(
		f.sqlite
			.prepare("SELECT chunk_count FROM turret_sessions")
			.pluck()
			.get(),
		1
	);
});

test("concurrent commits preserve one sequence and legacy objects can be verified without checksum metadata", async (t) => {
	const f = await ingestFixture(t);
	const chunk = JSON.stringify({ seq: 0, events: [] });
	const responses = await Promise.all([
		f.request("chunk", chunk),
		f.request("chunk", chunk),
	]);
	assert.deepEqual(
		responses.map((response) => response.status),
		[200, 200]
	);
	assert.equal(f.writes.length, 1);
	assert.equal(
		f.sqlite
			.prepare("SELECT chunk_count FROM turret_sessions")
			.pluck()
			.get(),
		1
	);
	const [key, object] = [...f.objects.entries()][0];
	f.objects.set(key, { json: object.json });
	assert.equal((await f.request("chunk", chunk)).status, 200);
	assert.equal(
		(
			await f.request(
				"chunk",
				JSON.stringify({ seq: 0, events: ["different"] })
			)
		).status,
		409
	);
	const competing = await Promise.all([
		f.request("chunk", JSON.stringify({ seq: 1, events: ["first"] })),
		f.request("chunk", JSON.stringify({ seq: 1, events: ["second"] })),
	]);
	assert.deepEqual(
		competing.map((response) => response.status).sort(),
		[200, 409]
	);
	assert.equal(
		f.sqlite
			.prepare("SELECT chunk_count FROM turret_sessions")
			.pluck()
			.get(),
		2
	);
});

test("feedback validates before storage and preserves accepted message boundaries", async (t) => {
	const f = await ingestFixture(t);

	const input = {
		ts: 1000,
		kind: "bug",
		message: "x",
		contact: "  user@example.test  ",
		url: "https://app.test/" + "a".repeat(3000),
	};
	for (const fields of [
		{ message: " " },
		{ message: "x".repeat(4001) },
		{ contact: "x".repeat(321) },
		{ ts: 1e100 },
	]) {
		const response = await f.request(
			"feedback",
			JSON.stringify({ ...input, ...fields })
		);
		assert.equal(response.status, 400, await response.clone().text());
	}
	assert.equal(
		f.sqlite
			.prepare("SELECT count(*) FROM turret_user_feedback")
			.pluck()
			.get(),
		0
	);
	for (const message of ["  x  ", "x".repeat(4000)]) {
		const response = await f.request(
			"feedback",
			JSON.stringify({ ...input, message })
		);
		assert.equal(response.status, 200, await response.clone().text());
	}
	const rows = f.sqlite
		.prepare<unknown[], { message: string; contact: string; url: string }>(
			"SELECT message, contact, url FROM turret_user_feedback ORDER BY rowid"
		)
		.all();
	assert.deepEqual(
		rows.map((row) => row.message),
		["x", "x".repeat(4000)]
	);
	assert.ok(
		rows.every(
			(row) =>
				row.contact === "user@example.test" &&
				row.url === input.url.slice(0, 2000)
		)
	);
});

test("error ingestion rejects invalid dates before writing and bounds stored diagnostics", async (t) => {
	const f = await ingestFixture(t);

	for (const ts of [-1, 1.5, 1e100, "NaN", "", null]) {
		const response = await f.request(
			"error",
			JSON.stringify({ ts, message: "invalid date" })
		);
		assert.equal(response.status, 400, await response.clone().text());
	}
	assert.equal(
		f.sqlite
			.prepare("SELECT count(*) FROM turret_session_errors")
			.pluck()
			.get(),
		0
	);
	assert.equal(
		f.sqlite
			.prepare("SELECT error_count FROM turret_sessions")
			.pluck()
			.get(),
		0
	);
	for (const ts of [0, 8_640_000_000_000_000]) {
		const response = await f.request(
			"error",
			JSON.stringify({
				ts,
				message: "m".repeat(2001),
				stack: "s".repeat(20001),
				fingerprint: "f".repeat(257),
			})
		);
		assert.equal(response.status, 200, await response.clone().text());
	}
	const rows = f.sqlite
		.prepare<
			unknown[],
			{ ts: number; message: string; stack: string; fingerprint: string }
		>(
			"SELECT ts, message, stack, fingerprint FROM turret_session_errors ORDER BY ts"
		)
		.all();
	assert.deepEqual(
		rows.map((row) => row.ts),
		[0, 8_640_000_000_000_000]
	);
	for (const row of rows) {
		assert.equal(row.message, "m".repeat(2000));
		assert.equal(row.stack, "s".repeat(20000));
		assert.equal(row.fingerprint, "f".repeat(256));
	}
});

test("client and worker error persistence rolls back failed session updates and keeps counts consistent", async (t) => {
	const f = await ingestFixture(t);
	const logged = t.mock.method(console, "error", () => {});
	f.sqlite
		.exec(`CREATE TRIGGER reject_error_count BEFORE UPDATE OF error_count ON turret_sessions
		BEGIN SELECT RAISE(ABORT, 'session metadata unavailable'); END`);
	const client = () =>
		f.request(
			"error",
			JSON.stringify({
				ts: 123,
				message: "Client error",
				fingerprint: "client-failure",
			})
		);
	const worker = (sessionId: string | null) =>
		recordWorkerError({
			pathTemplate: testRouteLabel("/api/example"),
			env: f.env,
			request: new Request("http://localhost:4321/api/example"),
			requestId: "worker-failure",
			correlation: { sessionId, ts: 123, replayTs: null },
			kind: "exception",
			error: new Error("Worker error"),
		});
	assert.equal((await client()).status, 500);
	await worker("session");
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_session_errors")
			.n,
		0
	);
	assert.deepEqual(
		readSqlRow(
			f.sqlite,
			"SELECT has_error, error_count FROM turret_sessions"
		),
		{ has_error: 0, error_count: 0 }
	);
	assert.ok(
		logged.mock.calls.some(
			(call) =>
				z
					.object({
						action: z.literal("turret.error_capture_failed"),
					})
					.safeParse(call.arguments[0]).success
		)
	);
	f.sqlite.exec("DROP TRIGGER reject_error_count");
	const responses = await Promise.all(Array.from({ length: 4 }, client));
	for (const response of responses)
		assert.equal(response.status, 200, await response.clone().text());
	await worker("session");
	assert.deepEqual(
		readSqlRow(
			f.sqlite,
			"SELECT has_error, error_count FROM turret_sessions"
		),
		{ has_error: 1, error_count: 5 }
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT count(*) AS n FROM turret_session_errors WHERE session_id='session'"
		).n,
		5
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT count(*) AS n FROM turret_session_errors WHERE expires_at != (SELECT retention_expires_at FROM turret_sessions)"
		).n,
		0
	);
	await worker(null);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT error_count FROM turret_sessions")
			.error_count,
		5
	);
	const unlinked = readSqlRow(
		f.sqlite,
		"SELECT expires_at, created_at FROM turret_session_errors WHERE session_id IS NULL"
	);
	assert.equal(
		Number(unlinked.expires_at) - Number(unlinked.created_at),
		24 * 60 * 60 * 1000
	);
});
