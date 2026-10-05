import assert from "node:assert/strict";
import test from "node:test";
import {
	traceOperation,
	type TraceSpan,
} from "../../src/worker/observability/tracing";

test("tracing annotates native spans, records failures and preserves the error", async () => {
	const errors: unknown[] = [];
	const attributes: unknown[] = [];
	const names: string[] = [];
	const span: TraceSpan = {
		setAttributes(value) {
			attributes.push(value);
		},
		recordException(error) {
			errors.push(error);
		},
	};
	const ctx = {
		waitUntil() {},
		tracing: {
			enterSpan<T>(name: string, fn: (span: TraceSpan) => T): T {
				names.push(name);
				return fn(span);
			},
		},
	};
	const failure = new Error("failed");
	await assert.rejects(
		traceOperation(
			ctx,
			"email.send",
			{ "request.id": "request-1" },
			async () => {
				throw failure;
			}
		),
		(error) => error === failure
	);
	assert.deepEqual(names, ["email.send"]);
	assert.deepEqual(attributes, [{ "request.id": "request-1" }]);
	assert.deepEqual(errors, [failure]);
	assert.equal(
		await traceOperation(undefined, "local", {}, async () => 42),
		42
	);
});
