import { createAuth } from "../../src/worker/auth";
import { testBindings, unavailableD1 } from "../helpers/worker";
import { z } from "zod";
import assert from "node:assert/strict";
import test from "node:test";

import { rootApp, routes } from "../../src/worker/api/routes/root";

void routes;

const healthResponseSchema = z.object({
	ok: z.boolean(),
	commit: z.string().nullable(),
	version: z.string().nullable(),
	auth: z.object({
		signupMode: z.enum(["invite_only", "open"]),
		selfSignUpEnabled: z.boolean(),
		googleSignInEnabled: z.boolean(),
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

async function getHealth(
	signupMode?: string,
	credentials: {
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		CF_VERSION_METADATA?: WorkerVersionMetadata;
	} = {}
): Promise<HealthResponse> {
	const res = await rootApp.fetch(
		new Request("http://local.test/health"),
		testBindings({ AUTH_SIGNUP_MODE: signupMode, ...credentials }),
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

test("health reports the serving Worker version and build commit pnpm ship waits for", async () => {
	const unversioned = await getHealth(undefined);
	assert.equal(unversioned.version, null);
	// The commit is injected by the Vite build; direct imports have none.
	assert.equal(unversioned.commit, null);
	const versioned = await getHealth(undefined, {
		CF_VERSION_METADATA: { id: "version-1", tag: "", timestamp: "" },
	});
	assert.equal(versioned.version, "version-1");
});

test("health provider availability agrees with Better Auth for complete and incomplete credentials", async () => {
	for (const [credentials, enabled] of [
		[{}, false],
		[{ GOOGLE_CLIENT_ID: "test-id" }, false],
		[{ GOOGLE_CLIENT_SECRET: "test-secret" }, false],
		[{ GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "" }, false],
		[
			{
				GOOGLE_CLIENT_ID: "test-id",
				GOOGLE_CLIENT_SECRET: "test-secret",
			},
			true,
		],
	] as const) {
		const env = testBindings({
			APP_URL: "http://localhost:4321",
			BETTER_AUTH_SECRET:
				"test-auth-secret-at-least-thirty-two-characters",
			CORE_DB: unavailableD1("Provider configuration must not query D1"),
			...credentials,
		});
		assert.equal(
			Boolean(createAuth(env).options.socialProviders?.google),
			enabled
		);
		assert.equal(
			(await getHealth(undefined, credentials)).auth.googleSignInEnabled,
			enabled
		);
	}
});
