import { testBindings } from "../helpers/worker";
import { z } from "zod";
import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapApp, routes } from "../../src/worker/api/routes/bootstrap";

void routes;

const bootstrapResponseSchema = z.object({
	ok: z.boolean(),
	status: z.enum(["bootstrapped", "already_bootstrapped"]),
});

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
		testBindings({ BOOTSTRAP_SECRET: "expected-secret" }),
		makeCtx()
	);

	assert.equal(res.status, 401);
	const body = bootstrapResponseSchema.parse(await res.json());
	assert.equal(body.ok, false);
	assert.equal(body.status, "already_bootstrapped");
});

test("bootstrap endpoint validates required env before DB access", async () => {
	const res = await bootstrapApp.fetch(
		new Request("http://local.test/internal/bootstrap-admin", {
			method: "POST",
			headers: { "x-bootstrap-secret": "expected-secret" },
		}),
		testBindings({ BOOTSTRAP_SECRET: "expected-secret" }),
		makeCtx()
	);

	assert.equal(res.status, 500);
	const body = bootstrapResponseSchema.parse(await res.json());
	assert.equal(body.ok, false);
	assert.equal(body.status, "already_bootstrapped");
});
