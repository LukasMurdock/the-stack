import assert from "node:assert/strict";
import test from "node:test";

import { turretApp, routes } from "../../src/worker/api/routes/turret";

void routes;

function makeCtx() {
	return {
		waitUntil() {},
		passThroughOnException() {},
		props: {},
	};
}

type ErrorResponse = {
	error: string;
	code?: string;
};

test("turret init returns 503 in off mode", async () => {
	const res = await turretApp.fetch(
		new Request("http://local.test/turret/session/init", {
			method: "POST",
			headers: {
				Origin: "http://localhost:4321",
			},
		}),
		{
			APP_URL: "http://localhost:4321",
			TURRET_MODE: "off",
		} as Record<string, unknown>,
		makeCtx() as never
	);

	assert.equal(res.status, 503);
	const payload = (await res.json()) as ErrorResponse;
	assert.equal(payload.code, "TURRET_DISABLED");
});

test("turret init degrades full mode without signing key", async () => {
	const res = await turretApp.fetch(
		new Request("http://local.test/turret/session/init", {
			method: "POST",
			headers: {
				Origin: "http://localhost:4321",
			},
		}),
		{
			APP_URL: "http://localhost:4321",
			TURRET_MODE: "full",
		} as Record<string, unknown>,
		makeCtx() as never
	);

	assert.equal(res.status, 503);
	const payload = (await res.json()) as ErrorResponse;
	assert.equal(payload.code, "TURRET_DEGRADED_MISSING_SIGNING_KEY");
});
