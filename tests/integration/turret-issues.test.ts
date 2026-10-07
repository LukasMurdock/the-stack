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
import { makeTurretDb } from "../../src/bindings/d1/turret/db";
import { persistError } from "../../src/worker/turret/errors";

const issueResponse = z.object({
	issue: z.object({
		fingerprint: z.string(),
		status: z.enum(["open", "resolved", "ignored"]),
		title: z.string().nullable(),
		occurrencesTotal: z.number(),
		sessionsAffectedTotal: z.number(),
		firstSeenAt: z.number(),
		lastSeenAt: z.number(),
		resolvedAt: z.number().nullable(),
		regressedAt: z.number().nullable(),
		resolvedInVersionId: z.string().nullable(),
		usersAffectedTotal: z.number(),
		priority: z.enum(["high", "medium", "low"]),
		reportsTotal: z.number(),
		representativeErrorId: z.string().nullable(),
		deployments: z.array(
			z.object({
				deploymentId: z.string().nullable(),
				occurrences: z.number(),
				firstSeenAt: z.number(),
				lastSeenAt: z.number(),
			})
		),
		// Null for issues whose only evidence is feedback reports.
		sample: z.object({
			errorId: z.string().nullable(),
			sessionId: z.string().nullable(),
			source: z.string().nullable(),
			message: z.string().nullable(),
			ts: z.number().nullable(),
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
	const bindings = {
		CORE_DB: f.binding,
		TURRET_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "local",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
	};
	const env = testBindings({
		...bindings,
		CF_VERSION_METADATA: { id: "v-current", tag: "", timestamp: "" },
	});
	const unversioned = testBindings(bindings);
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
	function request(
		path: string,
		body?: unknown,
		authenticated = true,
		bindings = env,
		method = body === undefined ? "GET" : "PATCH"
	) {
		return api.request(
			`${origin}/internal/turret/${path}`,
			{
				method,
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
					...(authenticated
						? { Authorization: `Bearer ${signedIn.token}` }
						: {}),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			bindings,
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
		"an occurrence after resolution reopens the issue as regressed until triaged",
		async () => {
			occurrence("regress-first", "regress", 100);
			const resolved = issueResponse.parse(
				await (
					await request("issue/regress", { status: "resolved" })
				).json()
			).issue;
			const resolvedAt = resolved.resolvedAt;
			assert.ok(resolvedAt);
			assert.equal(resolved.regressedAt, null);
			const db = makeTurretDb(f.binding);
			const capture = (ts: number) =>
				persistError(db, {
					sessionId: null,
					ts: new Date(ts),
					source: "worker",
					message: "recurred",
					fingerprint: "regress",
				});
			// Captured before resolution, delivered after: not a regression.
			await capture(resolvedAt - 1);
			let stored = issueResponse.parse(
				await (await request("issue/regress")).json()
			).issue;
			assert.equal(stored.status, "resolved");

			await capture(resolvedAt + 1);
			stored = issueResponse.parse(
				await (await request("issue/regress")).json()
			).issue;
			assert.equal(stored.status, "open");
			assert.equal(stored.regressedAt, resolvedAt + 1);
			assert.equal(stored.resolvedAt, resolvedAt);
			const window = `from=${resolvedAt - 10}&to=${resolvedAt + 10}`;
			const listed = async (view: string) =>
				z
					.object({
						issues: z.array(
							z.object({
								fingerprint: z.string(),
								regressedAt: z.number().nullable(),
							})
						),
					})
					.parse(
						await (
							await request(`issues?status=${view}&${window}`)
						).json()
					)
					.issues.filter((i) => i.fingerprint === "regress");
			assert.deepEqual(await listed("regressed"), [
				{ fingerprint: "regress", regressedAt: resolvedAt + 1 },
			]);
			assert.equal((await listed("open")).length, 1);
			assert.equal((await listed("resolved")).length, 0);

			// Repeating the current status is not a transition.
			stored = issueResponse.parse(
				await (
					await request("issue/regress", { status: "open" })
				).json()
			).issue;
			assert.equal(stored.regressedAt, resolvedAt + 1);
			stored = issueResponse.parse(
				await (
					await request("issue/regress", { status: "resolved" })
				).json()
			).issue;
			assert.equal(stored.regressedAt, null);
			assert.ok(stored.resolvedAt && stored.resolvedAt >= resolvedAt);
			f.sqlite.exec(
				"UPDATE turret_issue_state SET resolved_at=5 WHERE fingerprint='regress'"
			);
			stored = issueResponse.parse(
				await (
					await request("issue/regress", { status: "resolved" })
				).json()
			).issue;
			assert.equal(stored.resolvedAt, 5);
			stored = issueResponse.parse(
				await (
					await request("issue/regress", { status: "ignored" })
				).json()
			).issue;
			assert.equal(stored.resolvedAt, null);
			// Ignored issues stay ignored when the error recurs.
			await capture(Date.now() + 1);
			stored = issueResponse.parse(
				await (await request("issue/regress")).json()
			).issue;
			assert.equal(stored.status, "ignored");
			assert.equal(stored.regressedAt, null);
		}
	);

	await t.test(
		"resolving for the next deployment expects only the serving deployment's occurrences",
		async () => {
			occurrence("deploy-first", "deploy", 100);
			f.sqlite
				.prepare(
					"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, worker_version_id, created_at, updated_at) VALUES ('deploy-session', 0, 'user', 'v1', ?, 'v-current', 0, 0)"
				)
				.run(Date.now() + 60_000);
			const resolve = async (resolveIn?: string) =>
				issueResponse.parse(
					await (
						await request("issue/deploy", {
							status: "resolved",
							resolveIn,
						})
					).json()
				).issue;
			let stored = await resolve("next_deployment");
			assert.equal(stored.resolvedInVersionId, "v-current");
			const db = makeTurretDb(f.binding);
			const capture = (input: {
				sessionId?: string;
				deploymentId?: string | null;
			}) =>
				persistError(db, {
					sessionId: input.sessionId ?? null,
					deploymentId: input.deploymentId,
					ts: new Date(Date.now() + 1),
					source: "client",
					message: "recurred",
					fingerprint: "deploy",
				});
			// The fix hasn't shipped: the serving deployment still fails, whether
			// reported by the Worker or by a client session it served.
			await capture({ deploymentId: "v-current" });
			await capture({ sessionId: "deploy-session" });
			stored = issueResponse.parse(
				await (await request("issue/deploy")).json()
			).issue;
			assert.equal(stored.status, "resolved");
			assert.deepEqual(
				stored.deployments.map(({ deploymentId, occurrences }) => ({
					deploymentId,
					occurrences,
				})),
				[
					{ deploymentId: "v-current", occurrences: 2 },
					{ deploymentId: null, occurrences: 1 },
				]
			);

			await capture({ deploymentId: "v-next" });
			stored = issueResponse.parse(
				await (await request("issue/deploy")).json()
			).issue;
			assert.equal(stored.status, "open");
			assert.ok(stored.regressedAt);

			// An unknown deployment can't be ruled out.
			await resolve("next_deployment");
			await capture({ deploymentId: null });
			stored = issueResponse.parse(
				await (await request("issue/deploy")).json()
			).issue;
			assert.equal(stored.status, "open");

			stored = await resolve("next_deployment");
			assert.equal(stored.resolvedInVersionId, "v-current");
			stored = await resolve();
			assert.equal(stored.resolvedInVersionId, null);
			assert.equal(
				(await request("issue/deploy", { resolveIn: "now" })).status,
				400
			);
			const unknown = await request(
				"issue/deploy",
				{ status: "resolved", resolveIn: "next_deployment" },
				true,
				unversioned
			);
			assert.equal(unknown.status, 400);
			stored = issueResponse.parse(
				await (await request("issue/deploy")).json()
			).issue;
			assert.equal(stored.resolvedInVersionId, null);
		}
	);

	await t.test(
		"impact views separate new and escalating issues and sort by users or priority",
		async () => {
			const windowMs = 1_000_000;
			const from = 10 * windowMs;
			const to = from + windowMs;
			const session = f.sqlite.prepare(
				"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, created_at, updated_at) VALUES (?, 0, ?, 'v1', 0, 0, 0)"
			);
			for (const [id, user] of [
				["impact-a1", "user-a"],
				["impact-a2", "user-a"],
				["impact-b", "user-b"],
				["impact-c", "user-c"],
			])
				session.run(id, user);
			const error = f.sqlite.prepare(
				"INSERT INTO turret_session_errors (id, session_id, ts, source, message, fingerprint, created_at) VALUES (?, ?, ?, 'client', 'impact', ?, 0)"
			);
			const add = (
				fingerprint: string,
				count: number,
				start: number,
				sessions: string[]
			) => {
				for (let i = 0; i < count; i++)
					error.run(
						`${fingerprint}-${start}-${i}`,
						sessions[i % sessions.length],
						start + i,
						fingerprint
					);
			};
			// Doubled from one to ten, all from one user's two sessions.
			add("impact-escalating", 1, from - 100, ["impact-a1"]);
			add("impact-escalating", 10, from, ["impact-a1", "impact-a2"]);
			// Unchanged volume across three users.
			add("impact-steady", 10, from - 100, ["impact-a1"]);
			add("impact-steady", 10, from + 100, [
				"impact-a1",
				"impact-b",
				"impact-c",
			]);
			// First seen in this window, below the escalation minimum.
			add("impact-new", 2, from + 200, ["impact-b"]);
			await request("issue/impact-new", { priority: "high" });

			const list = async (query: string) =>
				z
					.object({
						issues: z.array(
							z.object({
								fingerprint: z.string(),
								firstSeenAt: z.number(),
								occurrences: z.number(),
								previousOccurrences: z.number(),
								sessionsAffected: z.number(),
								usersAffected: z.number(),
								priority: z.string(),
							})
						),
					})
					.parse(
						await (
							await request(
								`issues?from=${from}&to=${to}&${query}`
							)
						).json()
					)
					.issues.filter((i) => i.fingerprint.startsWith("impact-"));
			const fingerprints = async (query: string) =>
				(await list(query)).map((i) => i.fingerprint);

			assert.deepEqual(await fingerprints("status=escalating"), [
				"impact-escalating",
			]);
			assert.deepEqual(await fingerprints("status=new"), ["impact-new"]);
			assert.deepEqual(await fingerprints("sort=users"), [
				"impact-steady",
				"impact-escalating",
				"impact-new",
			]);
			assert.deepEqual(
				(await fingerprints("sort=priority"))[0],
				"impact-new"
			);
			const steady = (await list("sort=occurrences")).find(
				(i) => i.fingerprint === "impact-steady"
			);
			assert.deepEqual(steady, {
				fingerprint: "impact-steady",
				// First seen before the window, not at its first in-window occurrence.
				firstSeenAt: from - 100,
				occurrences: 10,
				previousOccurrences: 10,
				sessionsAffected: 3,
				usersAffected: 3,
				priority: "medium",
			});
			const escalating = issueResponse.parse(
				await (await request("issue/impact-escalating")).json()
			).issue;
			assert.equal(escalating.sessionsAffectedTotal, 2);
			assert.equal(escalating.usersAffectedTotal, 1);
		}
	);

	await t.test(
		"occurrence context selects playable replay and the nearest matching request",
		async () => {
			const now = Date.now();
			const session = f.sqlite.prepare(
				"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, chunk_count, created_at, updated_at) VALUES (?, 0, 'user', 'v1', ?, 1, 0, 0)"
			);
			session.run("ctx-playable", now + 60_000);
			session.run("ctx-expired", now - 60_000);
			const error = f.sqlite.prepare(
				"INSERT INTO turret_session_errors (id, session_id, ts, source, message, fingerprint, extra_json, created_at) VALUES (?, ?, ?, ?, ?, 'ctx', ?, 0)"
			);
			error.run("ctx-1", "ctx-playable", 1000, "client", "boom", "{}");
			error.run(
				"ctx-2",
				"ctx-expired",
				2000,
				"client",
				"boom",
				"not json"
			);
			error.run(
				"ctx-3",
				null,
				3000,
				"worker",
				"boom",
				JSON.stringify({
					request_id: "req-ctx",
					ray_id: "ray-ctx",
					worker_version: "v2",
					method: "POST",
					path: "/api/things",
					status: "500",
				})
			);
			const breadcrumb = f.sqlite.prepare(
				"INSERT INTO turret_request_breadcrumbs (id, request_id, session_id, ts, method, path, status, duration_ms, expires_at, created_at) VALUES (?, 'req-ctx', ?, ?, 'POST', '/api/things', 500, 12, ?, 0)"
			);
			breadcrumb.run(
				"bc-other-session",
				"ctx-playable",
				3000,
				now + 60_000
			);
			breadcrumb.run("bc-far", null, 9000, now + 60_000);
			breadcrumb.run("bc-near", null, 3100, now + 60_000);
			f.sqlite
				.prepare(
					"INSERT INTO turret_request_spans (id, breadcrumb_id, ts, kind, duration_ms, expires_at, created_at) VALUES ('span-near', 'bc-near', 3050, 'd1', 4, ?, 0)"
				)
				.run(now + 60_000);

			const detail = issueResponse.parse(
				await (await request("issue/ctx")).json()
			).issue;
			assert.equal(detail.sample.errorId, "ctx-3");
			assert.equal(detail.representativeErrorId, "ctx-1");

			const occurrenceResponse = z.object({
				occurrence: z.object({
					id: z.string(),
					replayAvailable: z.boolean(),
					newerId: z.string().nullable(),
					olderId: z.string().nullable(),
					correlation: z.object({
						requestId: z.string().nullable(),
						rayId: z.string().nullable(),
						workerVersion: z.string().nullable(),
						method: z.string().nullable(),
						route: z.string().nullable(),
						status: z.number().nullable(),
					}),
				}),
				request: z.object({ id: z.string() }).nullable(),
				requestSpans: z.array(z.object({ id: z.string() })),
			});
			const read = async (id: string) =>
				occurrenceResponse.parse(
					await (await request(`issue/ctx/event/${id}`)).json()
				);
			const worker = await read("ctx-3");
			assert.equal(worker.occurrence.replayAvailable, false);
			assert.deepEqual(worker.occurrence.correlation, {
				requestId: "req-ctx",
				rayId: "ray-ctx",
				workerVersion: "v2",
				method: "POST",
				route: "/api/things",
				// A mistyped key is dropped without discarding the others.
				status: null,
			});
			assert.equal(worker.request?.id, "bc-near");
			assert.deepEqual(
				worker.requestSpans.map((span) => span.id),
				["span-near"]
			);
			assert.equal(worker.occurrence.newerId, null);
			assert.equal(worker.occurrence.olderId, "ctx-2");

			const expired = await read("ctx-2");
			assert.equal(expired.occurrence.replayAvailable, false);
			assert.equal(expired.occurrence.correlation.requestId, null);
			assert.equal(expired.request, null);

			const playable = await read("ctx-1");
			assert.equal(playable.occurrence.replayAvailable, true);
			assert.equal(playable.occurrence.olderId, null);
			assert.equal(playable.occurrence.newerId, "ctx-2");

			assert.equal(
				(await request("issue/samples/event/ctx-1")).status,
				404
			);
		}
	);

	await t.test(
		"feedback reports become issue evidence through promotion and links",
		async () => {
			const now = Date.now();
			f.sqlite
				.prepare(
					"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, worker_version_id, created_at, updated_at) VALUES ('report-session', 0, 'reporter', 'v1', ?, 'v-current', 0, 0)"
				)
				.run(now + 60_000);
			const report = f.sqlite.prepare(
				"INSERT INTO turret_user_feedback (id, session_id, user_id, ts, kind, message, status, created_at, updated_at) VALUES (?, 'report-session', 'reporter', ?, 'bug', ?, 'open', 0, 0)"
			);
			report.run(
				"report-a",
				now - 1000,
				"\n  Checkout button does nothing\nDetails"
			);
			report.run("report-b", now - 500, "Totals look wrong");
			const send = (method: string, path: string, body?: unknown) =>
				request(path, body, true, env, method);
			const read = async (fingerprint: string) =>
				issueResponse.parse(
					await (
						await request(
							`issue/${encodeURIComponent(fingerprint)}`
						)
					).json()
				).issue;
			const feedbackStatus = (id: string) =>
				readSqlRow(
					f.sqlite,
					`SELECT status FROM turret_user_feedback WHERE id='${id}'`
				).status;

			const promoted = await send("POST", "feedback/report-a/issue");
			assert.equal(promoted.status, 200);
			const { issueFingerprint } = z
				.object({ issueFingerprint: z.string() })
				.parse(await promoted.json());
			assert.equal(issueFingerprint, "report:report-a");
			// Promoting again addresses the same issue.
			assert.equal(
				(await send("POST", "feedback/report-a/issue")).status,
				200
			);
			let issue = await read(issueFingerprint);
			assert.equal(issue.title, "Checkout button does nothing");
			assert.equal(issue.occurrencesTotal, 0);
			assert.equal(issue.reportsTotal, 1);
			assert.equal(issue.usersAffectedTotal, 1);
			assert.equal(issue.sessionsAffectedTotal, 1);
			assert.equal(issue.representativeErrorId, null);
			assert.equal(issue.sample.errorId, null);
			assert.equal(feedbackStatus("report-a"), "triaged");

			// Reports attach to error issues too; unknown issues gain nothing.
			assert.equal(
				(
					await send("PUT", "feedback/report-b/issue", {
						issueFingerprint: "missing",
					})
				).status,
				404
			);
			assert.equal(feedbackStatus("report-b"), "open");
			assert.equal(
				(
					await send("PUT", "feedback/report-b/issue", {
						issueFingerprint: "triage",
					})
				).status,
				200
			);
			assert.equal((await read("triage")).reportsTotal, 1);
			const reports = z
				.object({
					reports: z.array(
						z.object({
							id: z.string(),
							issueFingerprint: z.string().nullable(),
							replayAvailable: z.boolean(),
						})
					),
				})
				.parse(
					await (await request("issue/triage/reports")).json()
				).reports;
			assert.deepEqual(reports, [
				{
					id: "report-b",
					issueFingerprint: "triage",
					replayAvailable: false,
				},
			]);
			const listed = z
				.object({
					issues: z.array(
						z.object({
							fingerprint: z.string(),
							title: z.string().nullable(),
							occurrences: z.number(),
							reports: z.number(),
						})
					),
				})
				.parse(
					await (
						await request(
							`issues?from=${now - 2000}&to=${now}&q=checkout`
						)
					).json()
				).issues;
			assert.deepEqual(listed, [
				{
					fingerprint: "report:report-a",
					title: "Checkout button does nothing",
					occurrences: 0,
					reports: 1,
				},
			]);

			// A report made after resolution disproves the fix; an earlier one doesn't.
			await request(`issue/${encodeURIComponent(issueFingerprint)}`, {
				status: "resolved",
			});
			const resolvedAt = (await read(issueFingerprint)).resolvedAt ?? 0;
			report.run("report-before", resolvedAt - 1, "Still broken");
			report.run("report-after", resolvedAt + 1, "Broken again");
			await send("PUT", "feedback/report-before/issue", {
				issueFingerprint,
			});
			assert.equal((await read(issueFingerprint)).status, "resolved");
			await send("PUT", "feedback/report-after/issue", {
				issueFingerprint,
			});
			issue = await read(issueFingerprint);
			assert.equal(issue.status, "open");
			assert.equal(issue.regressedAt, resolvedAt + 1);
			assert.equal(issue.reportsTotal, 3);

			// Linking moves a report; an issue without evidence disappears.
			for (const id of ["report-a", "report-before", "report-after"])
				assert.equal(
					(await send("DELETE", `feedback/${id}/issue`)).status,
					200
				);
			assert.equal(
				(await request(`issue/${encodeURIComponent(issueFingerprint)}`))
					.status,
				404
			);
		}
	);

	await t.test(
		"ownership, notes and links record which administrator changed what",
		async () => {
			occurrence("owned-error", "owned", Date.now());
			const send = (method: string, path: string, body?: unknown) =>
				request(path, body, true, env, method);
			const activity = async () =>
				z
					.object({
						activity: z.array(
							z.object({
								actorId: z.string(),
								kind: z.string(),
								detail: z.record(z.string(), z.unknown()),
							})
						),
					})
					.parse(await (await request("issue/owned/activity")).json())
					.activity.map(({ actorId, kind, detail }) => ({
						actorId,
						kind,
						detail,
					}));

			const assignees = z
				.object({
					assignees: z.array(z.object({ id: z.string() })),
					currentUserId: z.string(),
				})
				.parse(await (await request("assignees")).json());
			assert.deepEqual(
				assignees.assignees.map(({ id }) => id),
				["owner"]
			);
			assert.equal(assignees.currentUserId, "owner");
			assert.equal(
				(await request("issue/owned", { assigneeId: "editor" })).status,
				400
			);
			for (let i = 0; i < 2; i++)
				assert.equal(
					(await request("issue/owned", { assigneeId: "owner" }))
						.status,
					200
				);
			for (let i = 0; i < 2; i++)
				await request("issue/owned", { status: "resolved" });
			await request("issue/owned", { priority: "medium" });
			const mine = async (assignee: string) =>
				z
					.object({
						issues: z.array(z.object({ fingerprint: z.string() })),
					})
					.parse(
						await (
							await request(
								`issues?status=resolved&assignee=${assignee}`
							)
						).json()
					)
					.issues.some((i) => i.fingerprint === "owned");
			assert.equal(await mine("me"), true);
			assert.equal(await mine("none"), false);

			assert.equal(
				(await send("POST", "issue/owned/notes", { body: "  " }))
					.status,
				400
			);
			assert.equal(
				(await send("POST", "issue/missing/notes", { body: "Hi" }))
					.status,
				404
			);
			assert.equal(
				(
					await send("POST", "issue/owned/notes", {
						body: "Reproduced on Safari.",
					})
				).status,
				200
			);
			const url = "https://github.com/example/app/pull/42";
			for (const linkUrl of ["javascript:alert(1)", "not a url"])
				assert.equal(
					(await send("POST", "issue/owned/links", { url: linkUrl }))
						.status,
					400
				);
			for (let i = 0; i < 2; i++)
				assert.equal(
					(await send("POST", "issue/owned/links", { url })).status,
					200
				);
			assert.equal(
				(await send("POST", "issue/missing/links", { url })).status,
				404
			);
			const links = issueResponse
				.extend({
					issue: issueResponse.shape.issue.extend({
						assigneeId: z.string().nullable(),
						links: z.array(
							z.object({ id: z.string(), url: z.string() })
						),
					}),
				})
				.parse(await (await request("issue/owned")).json()).issue;
			assert.equal(links.assigneeId, "owner");
			assert.deepEqual(
				links.links.map((link) => link.url),
				[url]
			);
			assert.equal(
				(await send("DELETE", `issue/owned/links/${links.links[0].id}`))
					.status,
				200
			);

			// Repeated values and links record nothing new; newest first.
			assert.deepEqual(await activity(), [
				{ actorId: "owner", kind: "link_removed", detail: { url } },
				{ actorId: "owner", kind: "link_added", detail: { url } },
				{
					actorId: "owner",
					kind: "note",
					detail: { body: "Reproduced on Safari." },
				},
				{
					actorId: "owner",
					kind: "status",
					detail: { status: "resolved", resolveIn: "now" },
				},
				{
					actorId: "owner",
					kind: "assignee",
					detail: { assigneeId: "owner" },
				},
			]);
		}
	);

	await t.test(
		"recovery compares affected replay sessions before and after resolution",
		async () => {
			const now = Date.now();
			const session = f.sqlite.prepare(
				"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, worker_version_id, created_at, updated_at) VALUES (?, ?, 'user', 'v1', ?, ?, 0, 0)"
			);
			const error = f.sqlite.prepare(
				"INSERT INTO turret_session_errors (id, session_id, ts, source, message, fingerprint, created_at) VALUES (?, ?, ?, 'client', 'recovering', ?, 0)"
			);
			// Half of ten sessions before resolution were affected.
			for (let i = 0; i < 10; i++) {
				session.run(
					`recovery-before-${i}`,
					now - 60_000,
					now + 60_000,
					"v-old"
				);
				if (i % 2 === 0)
					error.run(
						`recovery-error-${i}`,
						`recovery-before-${i}`,
						now - 60_000,
						"recovering"
					);
			}
			const recovery = async () =>
				z
					.object({
						recovery: z
							.object({
								before: z.object({
									sessions: z.number(),
									affected: z.number(),
								}),
								after: z.object({
									sessions: z.number(),
									affected: z.number(),
								}),
								verdict: z.string(),
								expectedAffected: z.number().nullable(),
							})
							.nullable(),
					})
					.parse(
						await (
							await request("issue/recovering/recovery")
						).json()
					).recovery;
			assert.equal(await recovery(), null);
			await request("issue/recovering", { status: "resolved" });
			f.sqlite
				.prepare(
					"UPDATE turret_issue_state SET resolved_at = ? WHERE fingerprint = 'recovering'"
				)
				.run(now - 30_000);
			const after = (id: string, version: string) =>
				session.run(id, now - 10_000, now + 60_000, version);

			// One clean session predicts half an affected one: not enough traffic.
			after("recovery-after-0", "v-new");
			let result = await recovery();
			assert.deepEqual(result?.before, { sessions: 10, affected: 5 });
			assert.equal(result?.verdict, "insufficient_traffic");
			assert.equal(result?.expectedAffected, 0.5);
			for (let i = 1; i < 6; i++) after(`recovery-after-${i}`, "v-new");
			result = await recovery();
			assert.equal(result?.verdict, "likely_fixed");
			assert.equal(result?.expectedAffected, 3);

			// Waiting for the next deployment, the old deployment's sessions
			// don't count toward recovery.
			f.sqlite
				.prepare(
					"UPDATE turret_issue_state SET resolved_in_version_id = 'v-new' WHERE fingerprint = 'recovering'"
				)
				.run();
			result = await recovery();
			assert.equal(result?.after.sessions, 0);
			assert.equal(result?.verdict, "insufficient_traffic");
		}
	);

	await t.test(
		"an investigation export carries observed facts and evidence links without identifying people",
		async () => {
			const now = Date.now();
			f.sqlite
				.prepare(
					"INSERT INTO turret_sessions (session_id, started_at, user_id, user_email, policy_version, retention_expires_at, chunk_count, created_at, updated_at) VALUES ('export-session', ?, 'export-user', 'person@example.test', 'v1', ?, 1, 0, 0)"
				)
				.run(now - 10_000, now + 60_000);
			f.sqlite
				.prepare(
					"INSERT INTO turret_session_errors (id, session_id, ts, source, message, stack, fingerprint, extra_json, created_at) VALUES ('export-error', 'export-session', ?, 'worker', 'Save failed', 'Error: Save failed\n    at save', 'exported', ?, 0)"
				)
				.run(
					now - 1000,
					JSON.stringify({
						request_id: "req-export",
						ray_id: "ray-export",
					})
				);
			f.sqlite
				.prepare(
					"INSERT INTO turret_request_breadcrumbs (id, request_id, session_id, ts, method, path, status, duration_ms, d1_queries_count, d1_queries_time_ms, expires_at, created_at) VALUES ('export-request', 'req-export', 'export-session', ?, 'POST', '/api/things', 500, 42, 3, 12, ?, 0)"
				)
				.run(now - 1001, now + 60_000);
			f.sqlite
				.prepare(
					"INSERT INTO turret_user_feedback (id, session_id, user_id, user_email, ts, kind, message, contact, status, created_at, updated_at) VALUES ('export-report', 'export-session', 'export-user', 'person@example.test', ?, 'bug', 'Saving does nothing', 'person@example.test', 'open', 0, 0)"
				)
				.run(now - 500);
			await request(
				"feedback/export-report/issue",
				{ issueFingerprint: "exported" },
				true,
				env,
				"PUT"
			);
			await request(
				"issue/exported/notes",
				{ body: "Started after the D1 migration." },
				true,
				env,
				"POST"
			);

			const response = await request("issue/exported/export");
			assert.equal(response.status, 200, await response.clone().text());
			const text = await response.clone().text();
			for (const personal of ["person@example.test", "export-user"])
				assert.equal(text.includes(personal), false, personal);
			const exported = z
				.object({
					issue: z.object({
						url: z.string(),
						occurrences: z.number(),
						reports: z.number(),
						users: z.number(),
					}),
					focus: z.object({
						kind: z.literal("error"),
						message: z.string(),
						requestId: z.string(),
						request: z.object({
							status: z.number(),
							database: z.object({ queries: z.number() }),
						}),
					}),
					replay: z.object({ url: z.string() }),
					timeline: z.array(
						z.object({
							kind: z.string(),
							offsetMs: z.number(),
							focus: z.boolean(),
						})
					),
					reports: z.array(z.object({ message: z.string() })),
					notes: z.array(z.object({ body: z.string() })),
					notCaptured: z.array(z.string()),
				})
				.parse(await response.json());
			assert.equal(
				exported.issue.url,
				"http://localhost:4321/app/ts_admin/turret/issues/exported?event=export-error"
			);
			assert.deepEqual(
				[
					exported.issue.occurrences,
					exported.issue.reports,
					exported.issue.users,
				],
				[1, 1, 1]
			);
			assert.equal(exported.focus.message, "Save failed");
			assert.equal(exported.focus.request.status, 500);
			assert.equal(exported.focus.request.database.queries, 3);
			assert.equal(
				exported.replay.url,
				`http://localhost:4321/app/ts_admin/turret/replay-sessions/export-session?t=${now - 6000}`
			);
			assert.deepEqual(
				exported.timeline.map(({ kind, offsetMs, focus }) => [
					kind,
					offsetMs,
					focus,
				]),
				[
					["request", -1, true],
					["error", 0, true],
					["report", 500, false],
				]
			);
			assert.deepEqual(
				exported.reports.map(({ message }) => message),
				["Saving does nothing"]
			);
			assert.deepEqual(exported.notes, [
				{ body: "Started after the D1 migration." },
			]);
			assert.ok(
				exported.notCaptured.some((gap) => gap.includes("sampled"))
			);
			assert.ok(
				exported.notCaptured.some((gap) => gap.includes("console"))
			);

			const byReport = await request(
				"issue/exported/export?report=export-report"
			);
			assert.equal(byReport.status, 200);
			assert.equal(
				z
					.object({ focus: z.object({ kind: z.string() }) })
					.parse(await byReport.json()).focus.kind,
				"report"
			);
			for (const path of [
				"issue/exported/export?report=unlinked",
				"issue/exported/export?event=ctx-1",
				"issue/missing/export",
			])
				assert.equal((await request(path)).status, 404, path);
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
