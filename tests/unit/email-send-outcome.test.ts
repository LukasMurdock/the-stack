import assert from "node:assert/strict";
import test from "node:test";
import {
	EMAIL_ERROR_CODE_LENGTH_MAX,
	EMAIL_ERROR_MESSAGE_LENGTH_MAX,
	EMAIL_LAST_SEND_KEY,
	boundedErrorCode,
	sanitizeProviderMessage,
} from "../../src/contracts/email-send-outcome";
import {
	acceptedOutcome,
	failedOutcome,
	needsWrite,
	readLastSend,
	recordEmailSendOutcome,
	recordEmailSendOutcomeSafely,
} from "../../src/worker/email/send-outcome";
import { fakeKv } from "../helpers/fake-kv";

const send = {
	type: "reset-password",
	provider: "cloudflare",
	atMs: 1_000,
} as const;

test("provider messages keep the cause and lose addresses, URLs and control characters", () => {
	assert.equal(
		sanitizeProviderMessage(
			"email sending not authorized for subdomain 'mail.company.com'"
		),
		"email sending not authorized for subdomain 'mail.company.com'"
	);
	assert.equal(
		sanitizeProviderMessage(
			"rejected owner@company.com <Team@Mail.company.com>\r\nsee https://app.company.com/reset?token=secret&u=a@b.c"
		),
		"rejected [address] <[address]> see [url]"
	);
	const long = sanitizeProviderMessage("x".repeat(1_000));
	assert.equal(long.length, EMAIL_ERROR_MESSAGE_LENGTH_MAX);
	assert.ok(long.endsWith("…"));
	assert.equal(boundedErrorCode(undefined), null);
	assert.equal(boundedErrorCode("  "), null);
	assert.equal(
		boundedErrorCode("E_SENDER_NOT_VERIFIED"),
		"E_SENDER_NOT_VERIFIED"
	);
	assert.equal(
		boundedErrorCode("E".repeat(200))?.length,
		EMAIL_ERROR_CODE_LENGTH_MAX
	);
});

test("a failure records a sanitized message and code; non-Error throws are kept as text", () => {
	const failure = Object.assign(
		new Error("not authorized to send to user@example.net"),
		{ code: "E_NOT_AUTHORIZED" }
	);
	assert.deepEqual(
		failedOutcome(send, { error: failure, code: failure.code }),
		{
			outcome: "failed",
			...send,
			code: "E_NOT_AUTHORIZED",
			message: "not authorized to send to [address]",
		}
	);
	assert.equal(
		failedOutcome(send, { error: "", code: undefined }).message,
		null
	);
});

test("every failure is written; a success only when it changes the outcome", async () => {
	const failed = failedOutcome(send, { error: new Error("no"), code: "E" });
	const accepted = acceptedOutcome({ ...send, atMs: 2_000 });
	assert.equal(needsWrite(null, failed), true);
	assert.equal(needsWrite(failed, failed), true);
	assert.equal(needsWrite(null, accepted), true);
	assert.equal(needsWrite(failed, accepted), true);
	assert.equal(needsWrite(accepted, accepted), false);

	const store = fakeKv();
	assert.equal(await recordEmailSendOutcome(store.kv, accepted), "written");
	assert.equal(
		await recordEmailSendOutcome(store.kv, { ...accepted, atMs: 3_000 }),
		"unchanged"
	);
	assert.equal(store.putsCount(), 1);
	assert.equal((await readLastSend(store.kv))?.atMs, 2_000);
	await recordEmailSendOutcome(store.kv, failed);
	await recordEmailSendOutcome(store.kv, { ...failed, atMs: 4_000 });
	assert.equal(store.putsCount(), 3);
	assert.deepEqual(await readLastSend(store.kv), { ...failed, atMs: 4_000 });
});

test("an unreadable record reads as none", async () => {
	for (const raw of ["not json", JSON.stringify({ outcome: "maybe" })])
		assert.equal(
			await readLastSend(fakeKv({ [EMAIL_LAST_SEND_KEY]: raw }).kv),
			null
		);
});

test("a store failure is logged, not thrown", async (t) => {
	const logged: string[] = [];
	for (const method of ["log", "info", "warn", "error"] as const)
		t.mock.method(console, method, (...args: unknown[]) => {
			logged.push(JSON.stringify(args));
		});
	const failing = {
		async get(): Promise<string | null> {
			throw new Error("KV get limit");
		},
		async put(): Promise<void> {
			throw new Error("KV put limit");
		},
	};
	await recordEmailSendOutcomeSafely(failing, acceptedOutcome(send));
	await recordEmailSendOutcomeSafely(
		failing,
		failedOutcome(send, { error: new Error("no"), code: undefined })
	);
	const output = logged.join("\n");
	assert.match(output, /email.outcome_record_failed/);
	assert.match(output, /KV get limit/);
	assert.match(output, /KV put limit/);
});
