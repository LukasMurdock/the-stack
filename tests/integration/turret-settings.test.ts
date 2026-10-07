import { z } from "zod";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { hashPassword } from "better-auth/crypto";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import { productErrorSchema } from "../../src/contracts/operation";
import { turretComplianceSchema } from "../../src/contracts/turret-policy";
import { turretFeaturesSchema } from "../../src/contracts/turret-features";
import { COMPLIANCE_KEY } from "../../src/worker/turret/compliance";
import { FEATURES_KEY } from "../../src/worker/turret/features";

const policyResponse = z.object({ policy: turretComplianceSchema });
const featuresResponse = z.object({ features: turretFeaturesSchema });

async function settingsFixture(t: TestContext, role = "admin") {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const origin = "http://localhost:4321";
	const stored = new Map<string, string>();
	const writes: string[] = [];
	const kv = {
		async get(key: string) {
			const value = stored.get(key);
			return value ? JSON.parse(value) : null;
		},
		async put(key: string, value: string) {
			stored.set(key, value);
			writes.push(key);
		},
	};
	const env = testBindings({
		CORE_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "local",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
		// SAFETY: these routes exercise only JSON get and string put on the fixture KV.
		TURRET_CFG: kv as KVNamespace,
	});
	f.sqlite.prepare("update auth_user set role=? where id='owner'").run(role);
	const password = "Valid-test-password-123!";
	f.sqlite
		.prepare(
			"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, ?, 'credential', ?, ?, ?)"
		)
		.run(
			crypto.randomUUID(),
			"owner",
			"owner",
			await hashPassword(password),
			Date.now()
		);
	const signedIn = await createAuth(env).api.signInEmail({
		body: { email: "owner@example.test", password },
		headers: new Headers({ Origin: origin }),
	});
	async function request(path: string, body?: unknown, authenticated = true) {
		return api.request(
			`${origin}/internal/turret/${path}`,
			{
				method: body === undefined ? "GET" : "PUT",
				headers: {
					Origin: origin,
					...(authenticated
						? { Authorization: `Bearer ${signedIn.token}` }
						: {}),
					"Content-Type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env,
			{ waitUntil() {}, passThroughOnException() {}, props: {} }
		);
	}
	return { request, stored, writes };
}

test("policy updates reject invalid input before storage and preserve omitted nested settings", async (t) => {
	const { request, stored, writes } = await settingsFixture(t);
	const defaults = await request("compliance");
	assert.equal(defaults.status, 200);
	assert.deepEqual(
		policyResponse.parse(await defaults.json()).policy,
		turretComplianceSchema.parse({})
	);
	const initial = await request("compliance", {
		retentionDays: 30,
		rrweb: { maskAllInputs: false },
		console: {
			enabled: false,
			level: ["error"],
			lengthThreshold: 400,
			stringifyOptions: {
				stringLengthLimit: 50,
				numOfKeysLimit: 70,
				depthOfLimit: 4,
			},
		},
	});
	assert.equal(initial.status, 200, await initial.clone().text());
	const changed = await request("compliance", {
		console: { stringifyOptions: { depthOfLimit: 5 } },
	});
	assert.equal(changed.status, 200);
	const policy = policyResponse.parse(await changed.json()).policy;
	assert.equal(policy.retentionDays, 30);
	assert.equal(policy.rrweb.maskAllInputs, false);
	assert.equal(policy.console.enabled, false);
	assert.deepEqual(policy.console.level, ["error"]);
	assert.equal(policy.console.lengthThreshold, 400);
	assert.deepEqual(policy.console.stringifyOptions, {
		stringLengthLimit: 50,
		numOfKeysLimit: 70,
		depthOfLimit: 5,
	});
	const unchanged = await request("compliance", {
		rrweb: {},
		console: { stringifyOptions: {} },
	});
	assert.equal(unchanged.status, 200);
	assert.deepEqual(
		policyResponse.parse(await unchanged.json()).policy,
		policy
	);
	const saved = stored.get(COMPLIANCE_KEY);
	const writesBefore = writes.length;
	for (const input of [
		{ console: { lengthThreshold: -1 } },
		{ console: { level: ["invalid"] } },
		{ console: { stringifyOptions: { depthOfLimit: 0 } } },
		{ rrweb: { maskAllInputs: "false" } },
		{ retentionDays: 366 },
		{ console: { enabld: false } },
		{ version: "client-supplied" },
	]) {
		const rejected = await request("compliance", input);
		assert.equal(rejected.status, 400, JSON.stringify(input));
		const error = productErrorSchema.parse(await rejected.json()).error;
		assert.equal(error.code, "invalid_input");
		assert.ok(error.fields);
	}
	assert.equal(writes.length, writesBefore);
	assert.equal(stored.get(COMPLIANCE_KEY), saved);
});

test("feature updates share stored defaults and do not reset omitted flags", async (t) => {
	const { request, stored, writes } = await settingsFixture(t);
	assert.deepEqual(
		featuresResponse.parse(await (await request("features")).json())
			.features,
		turretFeaturesSchema.parse({})
	);
	assert.equal(
		(await request("features", { storeUserEmail: false })).status,
		200
	);
	const empty = await request("features", {});
	assert.equal(empty.status, 200);
	assert.deepEqual(featuresResponse.parse(await empty.json()).features, {
		storeUserEmail: false,
	});
	assert.deepEqual(JSON.parse(stored.get(FEATURES_KEY) ?? "null"), {
		storeUserEmail: false,
	});
	const count = writes.length;
	for (const input of [{ storeUserEmail: "false" }, { unknownFlag: true }]) {
		const response = await request("features", input);
		assert.equal(response.status, 400);
		assert.equal(
			productErrorSchema.parse(await response.json()).error.code,
			"invalid_input"
		);
	}
	assert.equal(writes.length, count);
});

test("all paginated Turret routes reject invalid bounds before accessing telemetry storage", async (t) => {
	const { request } = await settingsFixture(t);
	for (const [path, maximum] of [
		["replay-sessions", 200],
		["replay-session/session/breadcrumbs", 200],
		["replay-session/session/spans", 5000],
		["issues", 200],
		["issue/fingerprint/events", 200],
		["feedback", 200],
		["replay-session/session/feedback", 200],
	] as const) {
		for (const query of [
			"limit=-1",
			"limit=nope",
			"limit=1.5",
			"limit=Infinity",
			`limit=${maximum + 1}`,
			"offset=-1",
			"offset=100001",
		]) {
			const response = await request(`${path}?${query}`);
			assert.equal(
				response.status,
				400,
				`${path}?${query}: ${await response.clone().text()}`
			);
			assert.equal(
				productErrorSchema.parse(await response.json()).error.code,
				"invalid_input"
			);
		}
	}
});

test("Turret ranges reject invalid timestamps, reversed windows, and unbounded trends before storage", async (t) => {
	const { request } = await settingsFixture(t);
	for (const path of [
		"replay-sessions",
		"issues",
		"feedback",
		"issue/test/trend",
	]) {
		for (const query of [
			"from=nope",
			"to=Infinity",
			"from=-1",
			"from=1.5",
			"from=",
			"to=8640000000000001",
			"from=2&to=1",
			"from=1&to=1",
		]) {
			const response = await request(`${path}?${query}`);
			assert.equal(
				response.status,
				400,
				`${path}?${query}: ${await response.clone().text()}`
			);
			assert.equal(
				productErrorSchema.parse(await response.json()).error.code,
				"invalid_input"
			);
		}
	}
	for (const query of [
		"from=0&to=3600000001&bucket=hour",
		"from=0&bucket=hour",
	]) {
		const response = await request(`issue/test/trend?${query}`);
		assert.equal(response.status, 400, await response.clone().text());
		assert.equal(
			productErrorSchema.parse(await response.json()).error.code,
			"invalid_input"
		);
	}
});

test("Turret admin authorization matches its documented responses across every route", async (t) => {
	const { request } = await settingsFixture(t, "user");
	const doc = api.getOpenAPIDocument({
		openapi: "3.0.0",
		info: { title: "Test", version: "1" },
	});
	let checked = 0;
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		if (!path.startsWith("/internal/turret/")) continue;
		for (const method of ["get", "put", "post", "delete"] as const) {
			const operation = item?.[method];
			if (!operation) continue;
			for (const status of [401, 403]) {
				const response: (typeof operation.responses)[string] =
					operation.responses[String(status)];
				assert.ok(
					response && "content" in response,
					`${method} ${path}: missing ${status}`
				);
				assert.deepEqual(
					response.content?.["application/json"]?.schema,
					{
						$ref: "#/components/schemas/TurretAdminErrorResponse",
					}
				);
			}
			checked++;
		}
	}
	assert.ok(checked > 0);
	for (const path of [
		"features",
		"compliance",
		"summary",
		"feedback",
		"issues",
		"replay-sessions",
	]) {
		for (const [authenticated, status, error] of [
			[false, 401, "Unauthorized"],
			[true, 403, "Forbidden"],
		] as const) {
			const response = await request(path, undefined, authenticated);
			assert.equal(response.status, status, path);
			assert.deepEqual(await response.json(), { error });
		}
	}
});
