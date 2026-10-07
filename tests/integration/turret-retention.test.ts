import assert from "node:assert/strict";
import test from "node:test";
import { migratedSqlite } from "../helpers/migrations";
import { makeTurretDb } from "../../src/bindings/d1/turret/db";
import {
	cleanupTurretStorage,
	readRetainedReplay,
	replayChunkKey,
} from "../../src/worker/turret/retention";
import { createSqliteD1, readSqlRow } from "../helpers/sqlite-d1";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";

function listObjects(
	objects: Set<string>,
	options?: R2ListOptions
): Promise<R2Objects> {
	return Promise.resolve({
		objects: [...objects]
			.filter((key) => key.startsWith(options?.prefix ?? ""))
			.sort()
			.slice(0, options?.limit ?? 1000)
			.map((key) => ({
				key,
				version: "fixture",
				size: 1,
				etag: "fixture",
				httpEtag: '"fixture"',
				uploaded: new Date(0),
				checksums: {
					toJSON() {
						return {};
					},
				},
				storageClass: "Standard",
				writeHttpMetadata() {},
			})),
		truncated: false,
		delimitedPrefixes: [],
	});
}

function fixture() {
	const sqlite = migratedSqlite("turret");
	const db = makeTurretDb(createSqliteD1(sqlite));
	function session(id: string, expiry: number, chunks: number) {
		sqlite
			.prepare(
				"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, created_at, updated_at) VALUES (?, 0, 'user', 'v1', ?, 0, 0)"
			)
			.run(id, expiry);
		for (let seq = 0; seq < chunks; seq++)
			sqlite
				.prepare(
					"INSERT INTO turret_session_chunks (session_id, seq, r2_key, size, created_at) VALUES (?, ?, ?, 1, 0)"
				)
				.run(id, seq, replayChunkKey(id, seq));
	}
	return { sqlite, db, session };
}

test("expiry hides replay immediately; cleanup is bounded and preserves live data", async (t) => {
	const f = fixture();
	t.after(() => f.sqlite.close());
	f.session("expired", 1000, 103);
	f.session("live", 1001, 1);
	const objects = new Set(
		Array.from({ length: 103 }, (_, seq) => replayChunkKey("expired", seq))
	);
	objects.add(replayChunkKey("live", 0));
	const bucket = {
		list: (options?: R2ListOptions) => listObjects(objects, options),
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys) {
				// References must still exist when deletion starts.
				assert.equal(
					f.sqlite
						.prepare(
							"SELECT count(*) FROM turret_session_chunks WHERE r2_key = ?"
						)
						.pluck()
						.get(key),
					1
				);
				// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes a fixture R2 key from a Set.
				objects.delete(key);
			}
		},
	};
	assert.equal(await readRetainedReplay(f.db, "expired", 1000), undefined);
	assert.equal(
		(await readRetainedReplay(f.db, "live", 1000))?.sessionId,
		"live"
	);
	assert.deepEqual(await cleanupTurretStorage(f.db, bucket, 1000), {
		deletedSessions: 0,
		deletedChunks: 99,
	});
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_sessions").n,
		2
	);
	assert.deepEqual(await cleanupTurretStorage(f.db, bucket, 1000), {
		deletedSessions: 1,
		deletedChunks: 4,
	});
	assert.deepEqual(objects, new Set([replayChunkKey("live", 0)]));
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_session_chunks")
			.n,
		1
	);
	assert.deepEqual(await cleanupTurretStorage(f.db, bucket, 1000), {
		deletedSessions: 0,
		deletedChunks: 0,
	});
});

test("R2 and database failures preserve enough metadata to retry", async (t) => {
	const f = fixture();
	t.after(() => f.sqlite.close());
	f.session("expired", 1000, 2);
	const objects = new Set([
		replayChunkKey("expired", 0),
		replayChunkKey("expired", 1),
	]);
	await assert.rejects(
		cleanupTurretStorage(
			f.db,
			{
				list: (options?: R2ListOptions) =>
					listObjects(objects, options),
				async delete() {
					// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes a fixture R2 key from a Set.
					objects.delete(replayChunkKey("expired", 0));
					throw new Error("R2 unavailable after partial deletion");
				},
			},
			1000
		),
		/R2 unavailable/
	);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_session_chunks")
			.n,
		2
	);
	const bucket = {
		list: (options?: R2ListOptions) => listObjects(objects, options),
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys)
				// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes a fixture R2 key from a Set.
				objects.delete(key);
		},
	};
	f.sqlite.exec(
		"CREATE TRIGGER fail_chunk_delete BEFORE DELETE ON turret_session_chunks BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END"
	);
	await assert.rejects(
		cleanupTurretStorage(f.db, bucket, 1000),
		/Failed query/
	);
	assert.equal(objects.size, 0);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_sessions").n,
		1
	);
	f.sqlite.exec("DROP TRIGGER fail_chunk_delete");
	assert.deepEqual(await cleanupTurretStorage(f.db, bucket, 1000), {
		deletedSessions: 1,
		deletedChunks: 2,
	});
});

test("cleanup limits session batches and removes legacy linked telemetry and feedback", async (t) => {
	const f = fixture();
	t.after(() => f.sqlite.close());
	for (let i = 0; i < 11; i++) f.session(`expired-${i}`, 1000, 0);
	f.sqlite.exec(
		"INSERT INTO turret_session_errors (id, session_id, ts, source, created_at) VALUES ('legacy', 'expired-0', 0, 'window', 0)"
	);
	f.sqlite.exec(
		"INSERT INTO turret_user_feedback (id, session_id, user_id, ts, kind, message, created_at, updated_at) VALUES ('legacy', 'expired-0', 'user', 0, 'bug', 'Legacy feedback', 0, 0)"
	);
	f.sqlite.exec(
		"INSERT INTO turret_issue_feedback (feedback_id, fingerprint, created_at) VALUES ('legacy', 'report:legacy', 0)"
	);
	f.sqlite.exec(
		"INSERT INTO turret_outcome_attempts (id, workflow, session_id, user_id, started_at, last_event_at, expires_at, created_at) VALUES ('attempt', 'project.create', 'expired-0', 'user', 0, 0, 5000, 0)"
	);
	const bucket = {
		list: (options?: R2ListOptions) => listObjects(new Set(), options),
		async delete() {
			assert.fail("No replay objects to delete");
		},
	};
	assert.equal(
		(await cleanupTurretStorage(f.db, bucket, 1000)).deletedSessions,
		10
	);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_sessions").n,
		1
	);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_session_errors")
			.n,
		0
	);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_user_feedback")
			.n,
		0
	);
	assert.equal(
		readSqlRow(
			f.sqlite,
			"SELECT count(*) AS n FROM turret_outcome_attempts"
		).n,
		0
	);
	// A report's issue link is evidence that expires with the report.
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_issue_feedback")
			.n,
		0
	);
	assert.equal(
		(await cleanupTurretStorage(f.db, bucket, 1000)).deletedSessions,
		1
	);
});

test("replay-backed readers preserve authorization, expiry and response contracts", async (t) => {
	const f = fixture();
	const core = productFixture();
	t.after(() => {
		f.sqlite.close();
		core.sqlite.close();
	});
	f.session("expired", 0, 1);
	f.session("live", Date.now() + 60_000, 1);
	const origin = "http://localhost:4321";
	let r2Reads = 0;
	const bucket: Pick<R2Bucket, "get"> = {
		async get() {
			r2Reads++;
			const body = Response.json({
				seq: 0,
				events: [],
				ts_start: 0,
				ts_end: 0,
			}).body;
			assert.ok(body);
			// SAFETY: the replay reader consumes only the platform object's body stream.
			return { body } as R2ObjectBody;
		},
	};
	const env = testBindings({
		CORE_DB: core.binding,
		TURRET_DB: createSqliteD1(f.sqlite),
		APP_URL: origin,
		APP_ENV: "local",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
		// SAFETY: replay reads exercise only get() and stream the returned body.
		TURRET_REPLAY_BUCKET: bucket as R2Bucket,
	});
	core.sqlite.exec("UPDATE auth_user SET role = 'admin' WHERE id = 'owner'");
	const password = "Valid-test-password-123!";
	core.sqlite
		.prepare(
			"INSERT INTO auth_account (id, account_id, provider_id, user_id, password, updated_at) VALUES ('account', 'owner', 'credential', 'owner', ?, ?)"
		)
		.run(await hashPassword(password), Date.now());
	const signedIn = await createAuth(env).api.signInEmail({
		body: { email: "owner@example.test", password },
		headers: new Headers({ Origin: origin }),
	});
	function request(path: string, authenticated = true) {
		return api.request(
			`${origin}/internal/turret/${path}`,
			{
				headers: authenticated
					? { Authorization: `Bearer ${signedIn.token}` }
					: {},
			},
			env,
			{ waitUntil() {}, passThroughOnException() {}, props: {} }
		);
	}
	const list = await request("replay-sessions");
	assert.equal(list.status, 200, await list.clone().text());
	assert.deepEqual(
		z
			.object({ sessions: z.array(z.object({ sessionId: z.string() })) })
			.parse(await list.json())
			.sessions.map((session) => session.sessionId),
		["live"]
	);
	for (const suffix of [
		"/meta",
		"/chunks",
		"/chunk/0",
		"/errors",
		"/breadcrumbs",
		"/spans",
		"/feedback",
	]) {
		const expired = await request(`replay-session/expired${suffix}`);
		assert.equal(expired.status, 404, suffix);
		assert.equal(
			(await request(`replay-session/live${suffix}`)).status,
			200,
			suffix
		);
		assert.equal(
			(await request(`replay-session/expired${suffix}`, false)).status,
			401,
			suffix
		);
	}
	assert.equal(r2Reads, 1);

	await t.test(
		"replay lists include the range start and exclude its end",
		async () => {
			f.sqlite.exec(
				"UPDATE turret_sessions SET started_at=1000 WHERE session_id='live'"
			);
			const schema = z.object({
				sessions: z.array(z.object({ sessionId: z.string() })),
			});
			const included = await request("replay-sessions?from=1000&to=1001");
			assert.equal(included.status, 200);
			assert.deepEqual(
				schema
					.parse(await included.json())
					.sessions.map((row) => row.sessionId),
				["live"]
			);
			const excluded = await request("replay-sessions?from=999&to=1000");
			assert.equal(excluded.status, 200);
			assert.deepEqual(schema.parse(await excluded.json()).sessions, []);
		}
	);

	await t.test(
		"grouped spans isolate observations sharing a correlation ID across sessions",
		async () => {
			f.sqlite.exec(`
			INSERT INTO turret_request_breadcrumbs (id, request_id, session_id, ts, method, path, status, duration_ms, expires_at, created_at)
			VALUES ('b1', 'request-a', 'live', 1000, 'GET', '/', 200, 5, 5000, 1000),
			('b2', 'request-a', 'expired', 1000, 'GET', '/', 200, 5, 5000, 1000);
			INSERT INTO turret_request_spans (id, breadcrumb_id, ts, kind, duration_ms, expires_at, created_at)
			VALUES ('s1', 'b1', 1000, 'd1', 5, 5000, 1000),
			('s2', 'b1', 1001, 'd1', 7, 5000, 1001),
			('other', 'b2', 1002, 'd1', 9, 5000, 1002);
		`);
			const span = z
				.object({
					id: z.string(),
					ts: z.string(),
					durationMs: z.number(),
					db: z.null(),
					createdAt: z.string(),
					expiresAt: z.string(),
				})
				.passthrough();
			const groupedSchema = z.object({
				spansByBreadcrumbId: z.record(z.string(), span.array()),
				hasMore: z.boolean(),
			});
			const grouped = await request("replay-session/live/spans?limit=1");
			assert.equal(grouped.status, 200, await grouped.clone().text());
			const first = groupedSchema.parse(await grouped.json());
			assert.equal(first.hasMore, true);
			assert.deepEqual(Object.keys(first.spansByBreadcrumbId), ["b1"]);
			assert.equal(
				first.spansByBreadcrumbId["b1"][0].ts,
				new Date(1000).toISOString()
			);
			const second = groupedSchema.parse(
				await (
					await request("replay-session/live/spans?limit=1&offset=1")
				).json()
			);
			assert.equal(second.hasMore, false);
			const direct = z
				.object({ spans: span.array() })
				.parse(await (await request("breadcrumb/b1/spans")).json());
			assert.deepEqual(
				[
					...first.spansByBreadcrumbId["b1"],
					...second.spansByBreadcrumbId["b1"],
				],
				direct.spans
			);
		}
	);

	await t.test(
		"request windows include the range start and exclude its end",
		async () => {
			f.sqlite.exec(`
			INSERT INTO turret_request_breadcrumbs (id, request_id, session_id, ts, method, path, status, duration_ms, expires_at, created_at)
			VALUES ('windowed', 'request-w', 'live', 3000, 'GET', '/', 200, 5, 5000, 3000);
		`);
			const ids = async (query: string) =>
				z
					.object({
						breadcrumbs: z.array(z.object({ id: z.string() })),
					})
					.parse(
						await (
							await request(
								`replay-session/live/breadcrumbs?${query}`
							)
						).json()
					)
					.breadcrumbs.map((row) => row.id);
			assert.deepEqual(await ids("from=3000&to=3001"), ["windowed"]);
			assert.deepEqual(await ids("from=2000&to=3000"), []);
			assert.equal(
				(
					await request(
						"replay-session/live/breadcrumbs?from=3000&to=3000"
					)
				).status,
				400
			);
		}
	);

	await t.test(
		"feedback readers share milliseconds, fields, filters and literal search",
		async () => {
			const now = Date.now();
			const insert = f.sqlite.prepare(
				"INSERT INTO turret_user_feedback (id, session_id, user_id, ts, kind, message, status, extra_json, expires_at, created_at, updated_at) VALUES (?, 'live', 'user', ?, ?, ?, ?, '{}', ?, ?, ?)"
			);
			insert.run(
				"feedback-a",
				now - 2,
				"bug",
				"100% broken",
				"open",
				now + 60000,
				now - 2,
				now - 1
			);
			insert.run(
				"feedback-b",
				now - 1,
				"idea",
				"100 percent improvement",
				"triaged",
				now + 60000,
				now - 1,
				now
			);
			const responseSchema = z.object({
				feedback: z.array(
					z
						.object({
							id: z.string(),
							ts: z.number(),
							createdAt: z.number(),
							updatedAt: z.number(),
						})
						.passthrough()
				),
			});
			const global = await request(
				"feedback?kind=bug&status=open&userId=user&sessionId=live&q=100%25"
			);
			assert.equal(global.status, 200, await global.clone().text());
			const rows = responseSchema.parse(await global.json()).feedback;
			assert.equal(rows.length, 1);
			assert.equal(rows[0].id, "feedback-a");
			assert.equal(rows[0].ts, now - 2);
			assert.equal(rows[0].updatedAt, now - 1);
			assert.equal("extraJson" in rows[0], false);
			assert.equal("expiresAt" in rows[0], false);
			const session = await request(
				"replay-session/live/feedback?limit=1&offset=1"
			);
			assert.equal(session.status, 200, await session.clone().text());
			assert.deepEqual(
				responseSchema.parse(await session.json()).feedback,
				rows
			);
			assert.equal(
				responseSchema.parse(
					await (await request("feedback?kind=praise")).json()
				).feedback.length,
				0
			);
		}
	);

	await t.test(
		"replay-user count excludes expired evidence before physical cleanup",
		async () => {
			const now = Date.now();
			f.sqlite
				.prepare(
					"UPDATE turret_sessions SET started_at=?, user_id=session_id"
				)
				.run(now - 1000);
			f.session("duplicate-user", now + 60000, 0);
			f.sqlite
				.prepare(
					"UPDATE turret_sessions SET started_at=?, user_id='live' WHERE session_id='duplicate-user'"
				)
				.run(now - 2000);
			const dashboardSchema = z
				.object({ usersWithRetainedReplays24h: z.number() })
				.passthrough();
			const before = await request("dashboard");
			assert.equal(before.status, 200, await before.clone().text());
			const data = dashboardSchema.parse(await before.json());
			assert.equal(data.usersWithRetainedReplays24h, 1);
			assert.equal("activeUsersDeltaPct" in data, false);
			assert.equal("activeUsersPrev24h" in data, false);
			const emptyObjects = new Set<string>();
			await cleanupTurretStorage(
				f.db,
				{
					list: (options) => listObjects(emptyObjects, options),
					async delete() {},
				},
				now
			);
			assert.equal(
				dashboardSchema.parse(await (await request("dashboard")).json())
					.usersWithRetainedReplays24h,
				1
			);
		}
	);

	await t.test(
		"replay, issue and feedback search share literal wildcard semantics",
		async () => {
			const now = Date.now();
			const pairs = [
				["path_with_under", "pathXwithXunder"],
				["95%complete", "95percentcomplete"],
				["path\\nested", "path/nested"],
			];
			for (const [index, pair] of pairs.entries()) {
				for (const [variant, message] of pair.entries()) {
					const id = `literal-${index}-${variant}`;
					f.session(id, now + 60_000, 0);
					f.sqlite
						.prepare(
							"UPDATE turret_sessions SET initial_url=? WHERE session_id=?"
						)
						.run(`https://example.test/${message}`, id);
					f.sqlite
						.prepare(
							"INSERT INTO turret_session_errors (id, session_id, ts, source, message, fingerprint, created_at) VALUES (?, ?, ?, 'client', ?, ?, ?)"
						)
						.run(id, id, now, message, id, now);
					f.sqlite
						.prepare(
							"INSERT INTO turret_user_feedback (id, session_id, user_id, ts, kind, message, created_at, updated_at) VALUES (?, ?, 'user', ?, 'bug', ?, ?, ?)"
						)
						.run(id, id, now, message, now, now);
				}
				const query = encodeURIComponent(pair[0]);
				for (const [endpoint, key, idKey] of [
					["replay-sessions", "sessions", "sessionId"],
					["issues", "issues", "fingerprint"],
					["feedback", "feedback", "id"],
				]) {
					const response = await request(`${endpoint}?q=${query}`);
					assert.equal(
						response.status,
						200,
						await response.clone().text()
					);
					const payload = z
						.record(z.string(), z.unknown())
						.parse(await response.json());
					const rows = z
						.array(z.record(z.string(), z.unknown()))
						.parse(payload[key]);
					assert.deepEqual(
						rows.map((row) => row[idKey]),
						[`literal-${index}-0`],
						endpoint
					);
				}
			}
		}
	);
});

test("prefix cleanup resumes orphaned objects without chunk metadata", async (t) => {
	const f = fixture();
	t.after(() => f.sqlite.close());
	f.session("expired", 1000, 0);
	const objects = new Set(
		Array.from({ length: 100 }, (_, seq) => replayChunkKey("expired", seq))
	);
	const bucket = {
		list: (options?: R2ListOptions) => listObjects(objects, options),
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys) {
				// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes a fixture R2 key from a Set.
				objects.delete(key);
			}
		},
	};
	assert.equal(
		(await cleanupTurretStorage(f.db, bucket, 1000)).deletedSessions,
		0
	);
	assert.equal(objects.size, 1);
	assert.equal(
		readSqlRow(f.sqlite, "SELECT count(*) AS n FROM turret_sessions").n,
		1
	);
	assert.equal(
		(await cleanupTurretStorage(f.db, bucket, 1000)).deletedSessions,
		1
	);
	assert.equal(objects.size, 0);
});
