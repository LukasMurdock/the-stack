import assert from "node:assert/strict";
import test from "node:test";

import { rootApp, routes } from "../../src/worker/api/routes/root";

void routes;

type HealthResponse = {
	ok: boolean;
	auth: {
		signupMode: "invite_only" | "open";
		selfSignUpEnabled: boolean;
	};
	turret: {
		configuredMode: "off" | "basic" | "full";
		effectiveMode: "off" | "basic" | "full";
		ingestEnabled: boolean;
		reason: string | null;
	};
};

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
		{ AUTH_SIGNUP_MODE: signupMode } as Record<string, unknown>,
		makeCtx() as never
	);

	assert.equal(res.status, 200);
	return (await res.json()) as HealthResponse;
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
