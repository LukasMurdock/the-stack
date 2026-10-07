import assert from "node:assert/strict";
import test from "node:test";
import { migratedSqlite } from "../helpers/migrations";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { productFixture } from "../helpers/product";
import { readSqlRow } from "../helpers/sqlite-d1";
import { testBindings } from "../helpers/worker";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";

const issueResponse = z.object({
	issue: z.object({
		fingerprint: z.string(),
		status: z.enum(["open", "resolved", "ignored"]),
		title: z.string().nullable(),
		occurrencesTotal: z.number(),
		sessionsAffectedTotal: z.number(),
		firstSeenAt: z.number(),
		lastSeenAt: z.number(),
		sample: z.object({
			errorId: z.string(),
			sessionId: z.string().nullable(),
			source: z.string(),
			message: z.string().nullable(),
			ts: z.number(),
		}),
	}),
});

test("issue triage and readers preserve partial edits and sample semantics", async (t) => {
	const f = productFixture(migratedSqlite("core", "turret"));
	t.after(() => f.sqlite.close());
	const insert = f.sqlite.prepare(
		"INSERT INTO turret_session_errors (id, session_id, ts, source, message, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
	);
	function occurrence(id: string, fingerprint: string, ts: number) {
		insert.run(
			id,
			`${id}-session`,
			ts,
			`${id}-source`,
			`${id}-message`,
			fingerprint,
			ts
		);
	}
	const origin = "http://localhost:4321";
	const env = testBindings({
		CORE_DB: f.binding,
		TURRET_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "local",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
	});
	f.sqlite.exec("UPDATE auth_user SET role='admin' WHERE id='owner'");
	const password = "Valid-test-password-123!";
	f.sqlite
		.prepare(
			"INSERT INTO auth_account (id, account_id, provider_id, user_id, password, updated_at) VALUES ('account', 'owner', 'credential', 'owner', ?, ?)"
		)
		.run(await hashPassword(password), Date.now());
	const signedIn = await createAuth(env).api.signInEmail({
		body: { email: "owner@example.test", password },
		headers: new Headers({ Origin: origin }),
	});
	function request(path: string, body?: unknown, authenticated = true) {
		return api.request(
			`${origin}/internal/turret/${path}`,
			{
				method: body === undefined ? "GET" : "PATCH",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
					...(authenticated
						? { Authorization: `Bearer ${signedIn.token}` }
						: {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
			{ waitUntil() {}, passThroughOnException() {}, props: {} }
		);
	}

	await t.test(
		"concurrent title and status edits compose for new and existing state",
		async () => {
			occurrence("triage-error", "triage", 100);
			const responses = await Promise.all([
				request("issue/triage", { status: "resolved" }),
				request("issue/triage", { title: "Investigate timeout" }),
			]);
			for (const response of responses)
				assert.equal(
					response.status,
					200,
					await response.clone().text()
				);
			let stored = issueResponse.parse(
				await (await request("issue/triage")).json()
			).issue;
			assert.equal(stored.status, "resolved");
			assert.equal(stored.title, "Investigate timeout");
			f.sqlite.exec(
				"UPDATE turret_issue_state SET created_at=123 WHERE fingerprint='triage'"
			);
			const updates = await Promise.all([
				request("issue/triage", { title: "New title" }),
				request("issue/triage", { status: "ignored" }),
			]);
			for (const response of updates)
				assert.equal(
					response.status,
					200,
					await response.clone().text()
				);
			stored = issueResponse.parse(
				await (await request("issue/triage")).json()
			).issue;
			assert.equal(stored.status, "ignored");
			assert.equal(stored.title, "New title");
			assert.equal(
				readSqlRow(
					f.sqlite,
					"SELECT created_at FROM turret_issue_state WHERE fingerprint='triage'"
				).created_at,
				123
			);
			// Model a status edit arriving immediately before the title patch writes.
			// A stale read/merge/write restores the old status; a field-specific
			// conflict update preserves the edit, even at this boundary.
			f.sqlite
				.exec(`CREATE TRIGGER intervening_status BEFORE INSERT ON turret_issue_state
				WHEN NEW.title = 'Trigger title'
				BEGIN UPDATE turret_issue_state SET status='resolved' WHERE fingerprint=NEW.fingerprint; END`);
			const intervened = await request("issue/triage", {
				title: "Trigger title",
			});
			assert.equal(intervened.status, 200);
			assert.equal(
				issueResponse.parse(await intervened.json()).issue.status,
				"resolved"
			);
			f.sqlite.exec("DROP TRIGGER intervening_status");

			const cleared = await request("issue/triage", { title: null });
			assert.equal(cleared.status, 200);
			assert.equal(
				issueResponse.parse(await cleared.json()).issue.title,
				"triage-error-message"
			);
			assert.equal(
				readSqlRow(
					f.sqlite,
					"SELECT title FROM turret_issue_state WHERE fingerprint='triage'"
				).title,
				null
			);
			const unchanged = await request("issue/triage", {});
			assert.equal(unchanged.status, 200);
			assert.equal(
				issueResponse.parse(await unchanged.json()).issue.status,
				"resolved"
			);
		}
	);

	await t.test(
		"one deterministic sample supplies every field and respects list windows",
		async () => {
			occurrence("a", "samples", 1000);
			occurrence("b", "samples", 1000);
			occurrence("c", "samples", 2000);
			const get = await request("issue/samples");
			assert.equal(get.status, 200);
			const detail = issueResponse.parse(await get.json()).issue;
			assert.deepEqual(detail.sample, {
				errorId: "c",
				sessionId: "c-session",
				source: "c-source",
				message: "c-message",
				ts: 2000,
			});
			assert.equal(detail.occurrencesTotal, 3);
			assert.equal(detail.sessionsAffectedTotal, 3);
			const patched = await request("issue/samples", {});
			assert.equal(patched.status, 200);
			assert.deepEqual(
				issueResponse.parse(await patched.json()).issue,
				detail
			);
			const list = await request("issues?from=1000&to=2000&limit=1");
			assert.equal(list.status, 200, await list.clone().text());
			const rows = z
				.object({
					issues: z.array(
						z.object({
							fingerprint: z.string(),
							title: z.string().nullable(),
							occurrences: z.number(),
							sample: issueResponse.shape.issue.shape.sample,
						})
					),
				})
				.parse(await list.json()).issues;
			assert.equal(rows.length, 1);
			assert.equal(rows[0].fingerprint, "samples");
			assert.equal(rows[0].occurrences, 2);
			assert.equal(rows[0].title, "b-message");
			assert.deepEqual(rows[0].sample, {
				errorId: "b",
				sessionId: "b-session",
				source: "b-source",
				message: "b-message",
				ts: 1000,
			});
			const searched = await request(
				"issues?from=1000&to=2000&q=a-message"
			);
			assert.equal(searched.status, 200);
			assert.equal(
				z
					.object({
						issues: z.array(
							z.object({
								sample: issueResponse.shape.issue.shape.sample,
							})
						),
					})
					.parse(await searched.json()).issues[0].sample.errorId,
				"b"
			);
			f.sqlite
				.prepare(
					"UPDATE turret_issue_state SET title='100% broken' WHERE fingerprint='samples'"
				)
				.run();
			const literal = await request("issues?from=1000&to=2000&q=100%25");
			assert.equal(literal.status, 200);
			assert.equal(
				z
					.object({
						issues: z.array(z.object({ title: z.string() })),
					})
					.parse(await literal.json()).issues[0].title,
				"100% broken"
			);
		}
	);

	await t.test(
		"missing, invalid and unauthorized patches leave state untouched",
		async () => {
			assert.equal(
				(await request("issue/missing", { status: "resolved" })).status,
				404
			);
			assert.equal((await request("issue/missing")).status, 404);
			assert.equal(
				(await request("issue/samples", { status: "invalid" })).status,
				400
			);
			assert.equal(
				(
					await request(
						"issue/samples",
						{ title: "unauthorized" },
						false
					)
				).status,
				401
			);
			assert.equal(
				readSqlRow(
					f.sqlite,
					"SELECT count(*) AS n FROM turret_issue_state WHERE fingerprint='missing'"
				).n,
				0
			);
			assert.equal(
				readSqlRow(
					f.sqlite,
					"SELECT title FROM turret_issue_state WHERE fingerprint='samples'"
				).title,
				"100% broken"
			);
		}
	);
});
