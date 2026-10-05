import { testBindings } from "../helpers/worker";
import { z } from "zod";
import assert from "node:assert/strict";
import test from "node:test";

import { rootApp, routes } from "../../src/worker/api/routes/root";

void routes;

const healthResponseSchema = z.object({
	ok: z.boolean(),
	auth: z.object({
		signupMode: z.enum(["invite_only", "open"]),
		selfSignUpEnabled: z.boolean(),
	}),
	turret: z.object({
		configuredMode: z.enum(["off", "basic", "full"]),
		effectiveMode: z.enum(["off", "basic", "full"]),
		ingestEnabled: z.boolean(),
		reason: z.string().nullable(),
	}),
});
type HealthResponse = z.infer<typeof healthResponseSchema>;

function makeCtx() {
	return {
		waitUntil() {},
		passThroughOnException() {},
		props: {},
	};
}

async function getHealth(signupMode?: string): Promise<HealthResponse> {
	const res = await rootApp.fetch(
		new Request("http://local.test/health"),
		testBindings({ AUTH_SIGNUP_MODE: signupMode }),
		makeCtx()
	);

	assert.equal(res.status, 200);
	return healthResponseSchema.parse(await res.json());
}

test("health defaults to invite_only auth mode", async () => {
	const payload = await getHealth(undefined);
	assert.equal(payload.ok, true);
	assert.equal(payload.auth.signupMode, "invite_only");
	assert.equal(payload.auth.selfSignUpEnabled, false);
	assert.equal(payload.turret.configuredMode, "full");
	assert.equal(payload.turret.effectiveMode, "basic");
	assert.equal(payload.turret.ingestEnabled, false);
	assert.equal(payload.turret.reason, "missing_turret_signing_key");
});

test("health reports open auth mode when configured", async () => {
	const payload = await getHealth("open");
	assert.equal(payload.auth.signupMode, "open");
	assert.equal(payload.auth.selfSignUpEnabled, true);
});
