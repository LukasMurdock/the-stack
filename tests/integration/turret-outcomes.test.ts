import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { migratedSqlite } from "../helpers/migrations";
import { productFixture } from "../helpers/product";
import { readSqlRow } from "../helpers/sqlite-d1";
import { testBindings } from "../helpers/worker";
import { api } from "../../src/worker/api";
import { createAuth } from "../../src/worker/auth";
import { signUploadToken } from "../../src/worker/api/routes/_shared/turret-upload-token";
import { makeTurretDb } from "../../src/bindings/d1/turret/db";
import { recordOutcomeEvent } from "../../src/worker/turret/outcomes";
import { TURRET_OUTCOME_IDLE_MS } from "../../src/contracts/turret-outcomes";

test("workflow outcomes record attempts once and summarize them by status", async (t) => {
	const f = productFixture(migratedSqlite("core", "turret"));
	t.after(() => f.sqlite.close());
	const now = Date.now();
	const session = f.sqlite.prepare(
		"INSERT INTO turret_sessions (session_id, started_at, user_id, policy_version, retention_expires_at, chunk_count, created_at, updated_at) VALUES (?, ?, ?, '1', ?, ?, 0, 0)"
	);
	session.run("session", now, "user", now + 60_000, 1);
	session.run("other", now, "other-user", now + 60_000, 0);
	const origin = "http://localhost:4321";
	const key = "test-upload-signing-key";
	const env = testBindings({
		CORE_DB: f.binding,
		TURRET_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "local",
		TURRET_MODE: "full",
		TURRET_SIGNING_KEY: key,
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
	});
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
	const uploadToken = await signUploadToken(key, {
		sid: "session",
		exp: now + 60_000,
		pv: "1",
	});
	f.sqlite.exec("UPDATE auth_user SET role='admin' WHERE id='owner'");
	const password = "Valid-test-password-123!";
	f.sqlite
		.prepare(
			"INSERT INTO auth_account (id, account_id, provider_id, user_id, password, updated_at) VALUES ('account', 'owner', 'credential', 'owner', ?, ?)"
		)
		.run(await hashPassword(password), now);
	const signedIn = await createAuth(env).api.signInEmail({
		body: { email: "owner@example.test", password },
		headers: new Headers({ Origin: origin }),
	});
	const db = makeTurretDb(f.binding);
	const attempt = (id: string) =>
		readSqlRow(
			f.sqlite,
			`SELECT started_at, succeeded_at, failures, last_failure_reason FROM turret_outcome_attempts WHERE id = '${id}'`
		);

	await t.test(
		"ingestion validates workflow events before storage",
		async () => {
			const post = (body: unknown) =>
				api.request(
					`${origin}/turret/replay-session/session/outcome`,
					{
						method: "POST",
						body: JSON.stringify(body),
						headers: {
							Origin: origin,
							"Content-Type": "application/json",
							Authorization: `Bearer ${uploadToken}`,
						},
					},
					env,
					ctx
				);
			const attemptId = crypto.randomUUID();
			const valid = {
				attemptId,
				workflow: "project.create",
				event: "started",
				ts: now,
			};
			for (const invalid of [
				{ ...valid, workflow: "checkout" },
				{ ...valid, event: "retried" },
				{ ...valid, attemptId: "not-a-uuid" },
				// Reasons are codes, never user content.
				{ ...valid, event: "failed", reason: "Name is taken by Alice" },
			])
				assert.equal((await post(invalid)).status, 400);
			assert.equal(
				readSqlRow(
					f.sqlite,
					"SELECT count(*) AS n FROM turret_outcome_attempts"
				).n,
				0
			);
			const response = await post(valid);
			assert.equal(response.status, 200, await response.clone().text());
			assert.equal(attempt(attemptId).started_at, now);
		}
	);

	await t.test(
		"an attempt keeps its earliest start, counts failures, and closes at its first success",
		async () => {
			const id = crypto.randomUUID();
			const event = (
				event: "started" | "failed" | "succeeded",
				ts: number,
				reason?: string
			) => ({
				attemptId: id,
				workflow: "project.create" as const,
				event,
				ts,
				reason,
			});
			// Delivery order differs from occurrence order.
			assert.ok(
				await recordOutcomeEvent(
					db,
					"session",
					event("failed", 200, "invalid_input")
				)
			);
			assert.ok(
				await recordOutcomeEvent(db, "session", event("started", 100))
			);
			assert.ok(
				await recordOutcomeEvent(
					db,
					"session",
					event("failed", 300, "network")
				)
			);
			assert.ok(
				await recordOutcomeEvent(db, "session", event("succeeded", 400))
			);
			assert.equal(
				await recordOutcomeEvent(
					db,
					"session",
					event("failed", 500, "late")
				),
				false
			);
			assert.deepEqual(attempt(id), {
				started_at: 100,
				succeeded_at: 400,
				failures: 2,
				last_failure_reason: "network",
			});
			// Another session or workflow can't alter the attempt.
			const other = crypto.randomUUID();
			await recordOutcomeEvent(db, "session", {
				attemptId: other,
				workflow: "project.create",
				event: "started",
				ts: 100,
			});
			assert.equal(
				await recordOutcomeEvent(db, "other", {
					attemptId: other,
					workflow: "project.create",
					event: "succeeded",
					ts: 200,
				}),
				false
			);
			assert.equal(
				await recordOutcomeEvent(db, "session", {
					attemptId: other,
					workflow: "invitation.accept",
					event: "succeeded",
					ts: 200,
				}),
				false
			);
			assert.equal(attempt(other).succeeded_at, null);
			assert.equal(
				await recordOutcomeEvent(db, "missing", {
					attemptId: crypto.randomUUID(),
					workflow: "project.create",
					event: "started",
					ts: 100,
				}),
				false
			);
		}
	);

	await t.test(
		"summaries derive failed and abandoned attempts after they go idle",
		async () => {
			f.sqlite.exec("DELETE FROM turret_outcome_attempts");
			const insert = f.sqlite.prepare(
				"INSERT INTO turret_outcome_attempts (id, workflow, session_id, user_id, started_at, last_event_at, succeeded_at, failures, last_failure_reason, expires_at, created_at) VALUES (?, 'invitation.accept', ?, 'user', ?, ?, ?, ?, ?, ?, 0)"
			);
			const idle = now - TURRET_OUTCOME_IDLE_MS - 1;
			const rows = [
				[
					"succeeded",
					"session",
					now - 5000,
					now - 4000,
					now - 4000,
					0,
					null,
				],
				[
					"recovered",
					"session",
					now - 5000,
					now - 3000,
					now - 3000,
					1,
					"network",
				],
				["failed", "session", idle - 10, idle, null, 2, "forbidden"],
				["failed-2", "other", idle - 10, idle, null, 1, "forbidden"],
				["abandoned", "session", idle - 10, idle, null, 0, null],
				[
					"active",
					"session",
					now - 2000,
					now - 1000,
					null,
					1,
					"network",
				],
			] as const;
			for (const [
				id,
				sessionId,
				started,
				last,
				succeeded,
				failures,
				reason,
			] of rows)
				insert.run(
					id,
					sessionId,
					started,
					last,
					succeeded,
					failures,
					reason,
					now + 60_000
				);
			const admin = (path: string) =>
				api.request(
					`${origin}/internal/turret/${path}`,
					{ headers: { Authorization: `Bearer ${signedIn.token}` } },
					env,
					ctx
				);
			const window = `from=${now - TURRET_OUTCOME_IDLE_MS * 2}&to=${now + 1}`;
			const summary = z
				.object({
					workflows: z.array(
						z.object({
							workflow: z.string(),
							attempts: z.number(),
							succeeded: z.number(),
							succeededAfterFailure: z.number(),
							failed: z.number(),
							abandoned: z.number(),
							inProgress: z.number(),
							reasons: z.array(
								z.object({
									reason: z.string(),
									attempts: z.number(),
								})
							),
						})
					),
				})
				.parse(await (await admin(`outcomes?${window}`)).json());
			assert.deepEqual(summary.workflows, [
				{
					workflow: "project.create",
					attempts: 0,
					succeeded: 0,
					succeededAfterFailure: 0,
					failed: 0,
					abandoned: 0,
					inProgress: 0,
					reasons: [],
				},
				{
					workflow: "invitation.accept",
					attempts: 6,
					succeeded: 2,
					succeededAfterFailure: 1,
					failed: 2,
					abandoned: 1,
					inProgress: 1,
					reasons: [
						{ reason: "forbidden", attempts: 2 },
						{ reason: "network", attempts: 2 },
					],
				},
			]);
			const attempts = z
				.object({
					attempts: z.array(
						z.object({
							id: z.string(),
							status: z.string(),
							replayAvailable: z.boolean(),
						})
					),
				})
				.parse(
					await (
						await admin(
							`outcomes/invitation.accept/attempts?status=failed&${window}`
						)
					).json()
				).attempts;
			assert.deepEqual(
				attempts
					.map(({ id, status, replayAvailable }) => ({
						id,
						status,
						replayAvailable,
					}))
					.sort((a, b) => a.id.localeCompare(b.id)),
				[
					{ id: "failed", status: "failed", replayAvailable: true },
					{
						id: "failed-2",
						status: "failed",
						replayAvailable: false,
					},
				]
			);
			assert.equal(
				(await admin(`outcomes/checkout/attempts?${window}`)).status,
				400
			);
		}
	);
});
