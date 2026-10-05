import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	sendEmail,
	resolveEmailTransport,
	type EmailEnvironment,
} from "../../src/worker/email/send-email";
import { createAuth, type AuthEnv } from "../../src/worker/auth";
import type {
	ObservabilityContext,
	TraceAttributes,
} from "../../src/worker/observability/tracing";

const message = {
	to: "receiver@example.net",
	subject: "Test",
	text: "Test",
	html: "<p>Test</p>",
};
const production = {
	APP_ENV: "production",
	EMAIL_FROM: "sender@example.com",
	EMAIL_FROM_NAME: "The Stack",
};
function tracing() {
	const errors: unknown[] = [];
	const attributes: TraceAttributes = {};
	const names: string[] = [];
	const pending: Promise<unknown>[] = [];
	const ctx: ObservabilityContext = {
		waitUntil(operation) {
			pending.push(operation);
		},
		tracing: {
			enterSpan(name, operation) {
				names.push(name);
				return operation({
					setAttributes(fields) {
						Object.assign(attributes, fields);
					},
					recordException(error) {
						errors.push(error);
					},
				});
			},
		},
	};
	return { ctx, pending, errors, attributes, names };
}

function captureLogs(t: TestContext) {
	const logs: unknown[][] = [];
	for (const method of ["log", "info", "error", "warn"] as const)
		t.mock.method(console, method, (...args: unknown[]) => {
			logs.push(args);
		});
	return logs;
}

test("Cloudflare sends composed email and records acceptance with correlation, not content", async (t) => {
	const logs = captureLogs(t);
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Cloudflare must not call Resend");
	});
	const trace = tracing();
	let calls = 0;
	const env: EmailEnvironment = {
		...production,
		CF_VERSION_METADATA: { id: "release-1" },
		EMAIL: {
			async send(input) {
				calls++;
				assert.deepEqual(input, {
					...message,
					from: { email: production.EMAIL_FROM, name: "The Stack" },
				});
				return { messageId: "cloudflare-id" };
			},
		},
	};
	assert.deepEqual(
		await sendEmail({
			...message,
			env,
			ctx: trace.ctx,
			requestId: "request-1",
		}),
		{ transport: "cloudflare", messageId: "cloudflare-id" }
	);
	assert.equal(calls, 1);
	assert.equal(trace.attributes["email.message_id"], "cloudflare-id");
	assert.equal(trace.attributes["request.id"], "request-1");
	assert.equal(trace.attributes["app.version"], "release-1");
	assert.deepEqual(trace.names, ["email.send"]);
	const output = JSON.stringify(logs);
	assert.match(output, /email.accepted/);
	assert.match(output, /cloudflare-id/);
	assert.doesNotMatch(output, /receiver@example.net|<p>Test<\/p>/);
});

test("local email is log-only even with credentials and log mode cannot reach production", async (t) => {
	captureLogs(t);
	let sends = 0;
	const local: EmailEnvironment = {
		...production,
		APP_ENV: "local",
		RESEND_API_KEY: "configured-but-not-selected",
		EMAIL: {
			async send() {
				sends++;
				return { messageId: "unexpected" };
			},
		},
	};
	assert.equal(resolveEmailTransport(local), "log");
	assert.deepEqual(await sendEmail({ ...message, env: local }), {
		transport: "log",
	});
	assert.equal(sends, 0);
	for (const EMAIL_TRANSPORT of ["log", "typo"])
		await assert.rejects(
			sendEmail({ ...message, env: { ...production, EMAIL_TRANSPORT } }),
			{ code: "E_EMAIL_CONFIGURATION" }
		);
	await assert.rejects(
		sendEmail({ ...message, env: production }),
		/EMAIL binding/
	);
	await assert.rejects(
		sendEmail({
			...message,
			env: { ...production, EMAIL_TRANSPORT: "resend" },
		}),
		/RESEND_API_KEY/
	);
});

test("Cloudflare suppression, quota and sender errors preserve codes and never fall back", async (t) => {
	captureLogs(t);
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Unexpected fallback");
	});
	for (const code of [
		"E_RECIPIENT_SUPPRESSED",
		"E_DAILY_LIMIT_EXCEEDED",
		"E_RATE_LIMIT_EXCEEDED",
		"E_SENDER_NOT_VERIFIED",
	]) {
		const trace = tracing();
		const failure = Object.assign(new Error("Provider failure"), { code });
		const env: EmailEnvironment = {
			...production,
			RESEND_API_KEY: "unused",
			EMAIL: {
				async send() {
					throw failure;
				},
			},
		};
		await assert.rejects(
			sendEmail({ ...message, env, ctx: trace.ctx }),
			(error) => error === failure
		);
		assert.deepEqual(trace.errors, [failure]);
		assert.equal(trace.attributes["email.error_code"], code);
	}
});

test("legacy sender display names remain supported and header injection is rejected", async (t) => {
	captureLogs(t);
	let sends = 0;
	const env: EmailEnvironment = {
		...production,
		EMAIL_FROM: "Existing Project <sender@example.com>",
		EMAIL_FROM_NAME: undefined,
		EMAIL: {
			async send(input) {
				sends++;
				assert.equal(
					(input as EmailMessageBuilder).from &&
						typeof (input as EmailMessageBuilder).from,
					"object"
				);
				assert.deepEqual((input as EmailMessageBuilder).from, {
					email: "sender@example.com",
					name: "Existing Project",
				});
				return { messageId: "legacy-id" };
			},
		},
	};
	await sendEmail({ ...message, env });
	await assert.rejects(
		sendEmail({
			...message,
			env: { ...env, EMAIL_FROM_NAME: "Bad\r\nBcc: someone@example.com" },
		}),
		/sender mailbox/
	);
	await assert.rejects(
		sendEmail({
			...message,
			env: { ...env, EMAIL_FROM: "not an address" },
		}),
		/sender mailbox/
	);
	assert.equal(sends, 1);
});

test("explicit Resend transport retains error tracing and validates acceptance IDs", async (t) => {
	captureLogs(t);
	const trace = tracing();
	const env = {
		...production,
		EMAIL_TRANSPORT: "resend",
		RESEND_API_KEY: "test-key",
	};
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				JSON.stringify({
					name: "validation_error",
					message: "Invalid sender",
				}),
				{ status: 422, headers: { "content-type": "application/json" } }
			)
	);
	await assert.rejects(
		sendEmail({ ...message, env, ctx: trace.ctx }),
		/Invalid sender/
	);
	assert.equal(trace.errors.length, 1);
	assert.equal((trace.errors[0] as Error).name, "validation_error");
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(JSON.stringify({ id: "resend-id" }), {
				headers: { "content-type": "application/json" },
			})
	);
	assert.deepEqual(await sendEmail({ ...message, env }), {
		transport: "resend",
		messageId: "resend-id",
	});
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response("{}", {
				headers: { "content-type": "application/json" },
			})
	);
	await assert.rejects(sendEmail({ ...message, env }), /no message ID/);
});

test("Better Auth callbacks render both email types, schedule delivery, and keep failures private", async (t) => {
	const logs = captureLogs(t);
	const trace = tracing();
	const messages: EmailMessageBuilder[] = [];
	const env = {
		...production,
		PRODUCT_NAME: "Starter",
		APP_URL: "https://app.example.com",
		BETTER_AUTH_SECRET:
			"auth-email-test-secret-with-at-least-32-characters",
		CORE_DB: {},
		CORE_KV: {},
		CF_VERSION_METADATA: { id: "release-1" },
		EMAIL: {
			async send(input: EmailMessageBuilder) {
				messages.push(input);
				return { messageId: "accepted-id" };
			},
		},
	} as unknown as AuthEnv;
	const auth = createAuth(env, trace.ctx, "auth-request-id");
	const url = "https://app.example.com/reset-password?token=auth-secret";
	const payload = {
		user: { email: "user@example.net" },
		url,
		token: "auth-secret",
	} as never;
	await auth.options.emailAndPassword?.sendResetPassword?.(
		payload,
		undefined
	);
	await auth.options.emailVerification?.sendVerificationEmail?.(
		payload,
		undefined
	);
	assert.equal(trace.pending.length, 2);
	await Promise.all(trace.pending);
	assert.equal(messages.length, 2);
	assert.match(messages[0].subject, /Reset your password for Starter/);
	assert.match(messages[1].subject, /Verify your email for Starter/);
	assert.match(messages[0].text ?? "", /Reset password/);
	assert.doesNotMatch(
		messages[0].text ?? "",
		/Thanks for signing up|Verify email/
	);
	assert.match(messages[1].text ?? "", /Verify email/);
	for (const sent of messages) {
		assert.ok(sent.html?.includes("auth-secret"));
		assert.ok(sent.text?.includes("auth-secret"));
	}
	assert.doesNotMatch(JSON.stringify(logs), /auth-secret/);
	assert.equal(trace.attributes["request.id"], "auth-request-id");

	const failure = Object.assign(new Error("Quota exceeded"), {
		code: "E_DAILY_LIMIT_EXCEEDED",
	});
	env.EMAIL.send = async () => {
		throw failure;
	};
	await auth.options.emailAndPassword?.sendResetPassword?.(
		payload,
		undefined
	);
	await Promise.all(trace.pending);
	const output = JSON.stringify(logs);
	assert.match(output, /email.send_failed/);
	assert.match(output, /E_DAILY_LIMIT_EXCEEDED/);
	assert.match(output, /auth-request-id/);
	assert.doesNotMatch(output, /auth-secret/);
});

test("auth URLs appear only for local log mode and production configuration failures are observable", async (t) => {
	const logs = captureLogs(t);
	const { sendAuthEmail } = await import("../../src/worker/email/auth-email");
	const options = {
		type: "verify-email" as const,
		to: "user@example.net",
		url: "https://app.example.com/verify?token=local-secret",
	};
	await sendAuthEmail({
		...options,
		env: { ...production, PRODUCT_NAME: "Starter", APP_ENV: "local" },
	});
	assert.match(JSON.stringify(logs), /local-secret/);
	logs.length = 0;
	await sendAuthEmail({
		...options,
		env: { ...production, PRODUCT_NAME: "Starter" },
	});
	assert.match(JSON.stringify(logs), /email.send_failed/);
	assert.match(JSON.stringify(logs), /E_EMAIL_CONFIGURATION/);
	assert.doesNotMatch(JSON.stringify(logs), /local-secret/);
});
