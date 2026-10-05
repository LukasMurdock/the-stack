import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail } from "../../src/worker/email/send-email";

test("Resend provider errors returned as data reject delivery and are traced", async (t) => {
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
	const errors: unknown[] = [];
	const ctx = {
		waitUntil() {},
		tracing: {
			enterSpan<T>(
				_name: string,
				operation: (span: {
					setAttributes(): void;
					recordException(error: unknown): void;
				}) => T
			): T {
				return operation({
					setAttributes() {},
					recordException(error) {
						errors.push(error);
					},
				});
			},
		},
	};
	await assert.rejects(
		sendEmail({
			ctx,
			resendApiKey: "test-key",
			from: "sender@example.com",
			to: "receiver@example.com",
			subject: "Test",
			text: "Test",
			html: "<p>Test</p>",
		}),
		/Invalid sender/
	);
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as Error).name, "validation_error");
});
