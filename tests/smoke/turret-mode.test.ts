import { testBindings } from "../helpers/worker";
import { z } from "zod";
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

const errorResponseSchema = z.object({
	error: z.string(),
	code: z.string().optional(),
});

test("turret init returns 503 in off mode", async () => {
	const res = await turretApp.fetch(
		new Request("http://local.test/turret/replay-session/init", {
			method: "POST",
			headers: {
				Origin: "http://localhost:4321",
			},
		}),
		testBindings({
			APP_URL: "http://localhost:4321",
			TURRET_MODE: "off",
		}),
		makeCtx()
	);

	assert.equal(res.status, 503);
	const payload = errorResponseSchema.parse(await res.json());
	assert.equal(payload.code, "TURRET_DISABLED");
});

test("turret init degrades full mode without signing key", async () => {
	const res = await turretApp.fetch(
		new Request("http://local.test/turret/replay-session/init", {
			method: "POST",
			headers: {
				Origin: "http://localhost:4321",
			},
		}),
		testBindings({
			APP_URL: "http://localhost:4321",
			TURRET_MODE: "full",
		}),
		makeCtx()
	);

	assert.equal(res.status, 503);
	const payload = errorResponseSchema.parse(await res.json());
	assert.equal(payload.code, "TURRET_DEGRADED_MISSING_SIGNING_KEY");
});
