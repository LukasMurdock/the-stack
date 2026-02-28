import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapApp, routes } from "../../src/worker/api/routes/bootstrap";

void routes;

type BootstrapResponse = {
	ok: boolean;
	status: "bootstrapped" | "already_bootstrapped";
};

function makeCtx() {
	return {
		waitUntil() {},
		passThroughOnException() {},
		props: {},
	};
}

test("bootstrap endpoint rejects missing or invalid secret", async () => {
	const res = await bootstrapApp.fetch(
		new Request("http://local.test/internal/bootstrap-admin", {
			method: "POST",
		}),
		{ BOOTSTRAP_SECRET: "expected-secret" } as Record<string, unknown>,
		makeCtx() as never
	);

	assert.equal(res.status, 401);
	const body = (await res.json()) as BootstrapResponse;
	assert.equal(body.ok, false);
	assert.equal(body.status, "already_bootstrapped");
});

test("bootstrap endpoint validates required env before DB access", async () => {
	const res = await bootstrapApp.fetch(
		new Request("http://local.test/internal/bootstrap-admin", {
			method: "POST",
			headers: { "x-bootstrap-secret": "expected-secret" },
		}),
		{ BOOTSTRAP_SECRET: "expected-secret" } as Record<string, unknown>,
		makeCtx() as never
	);

	assert.equal(res.status, 500);
	const body = (await res.json()) as BootstrapResponse;
	assert.equal(body.ok, false);
	assert.equal(body.status, "already_bootstrapped");
});
