import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { observeRequest } from "../../src/worker/observability/request";
import type { Bindings } from "../../src/worker/index";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import { organizationResponseSchema } from "../../src/contracts/organizations";
import { projectResponseSchema } from "../../src/features/projects/contracts";
import { productErrorSchema } from "../../src/contracts/operation";

const origin = "http://localhost:4321";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
test("HTTP authentication, validation, typed outcomes and resource routes work together", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const observedStatuses: number[] = [];
	const env = testBindings({
		TURRET_MODE: "off",
		TURRET_METRICS: {
			writeDataPoint(point) {
				assert.ok(point?.doubles);
				observedStatuses.push(point.doubles[1]);
			},
		},
		CORE_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "local",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
		AUTH_SIGNUP_MODE: "open",
	});
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
	const token = signedIn.token;
	const app = new Hono<{ Bindings: Bindings }>();
	app.use("*", observeRequest);
	app.route("/api", api);
	async function request(
		path: string,
		method = "GET",
		body?: unknown,
		bearer = token
	) {
		return app.request(
			`${origin}/api${path}`,
			{
				method,
				headers: {
					"Content-Type": "application/json",
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
					Origin: origin,
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			},
			env,
			context
		);
	}
	assert.equal(
		(await request("/organizations", "GET", undefined, "")).status,
		401
	);
	for (const [path, method] of [
		["/internal/turret/health", "GET"],
		["/internal/turret/summary", "GET"],
		["/internal/turret/features", "PUT"],
		["/internal/turret/compliance", "PUT"],
		["/internal/turret/issues", "GET"],
		["/internal/turret/feedback", "GET"],
		["/internal/turret/sessions", "GET"],
		["/internal/turret/session/test/meta", "GET"],
		["/internal/turret/session/test/feedback", "GET"],
	]) {
		assert.equal(
			(await request(path, method, undefined, "")).status,
			401,
			`${method} ${path}`
		);
		assert.equal(
			(await request(path, method)).status,
			403,
			`non-admin ${method} ${path}`
		);
	}
	for (const path of [
		"/turret/replay-session/init",
		"/turret/session/init",
	]) {
		const rejected = await app.request(
			`${origin}/api${path}`,
			{
				method: "POST",
				headers: { Origin: "https://other.test" },
			},
			env,
			context
		);
		assert.equal(rejected.status, 403, `cross-origin POST ${path}`);
	}
	const invalid = await request("/organizations", "POST", {
		name: "",
	});
	assert.equal(invalid.status, 400);
	assert.ok(
		productErrorSchema.parse(await invalid.json()).error.fields?.name
	);
	const created = await request("/organizations", "POST", {
		name: "Studio",
	});
	assert.equal(created.status, 200, await created.clone().text());
	const { organization } = organizationResponseSchema.parse(
		await created.json()
	);
	// Each endpoint owns its guards. Missing credentials must be rejected before
	// validating input, including writes without a body.
	const organizationPath = `/organizations/${organization.id}`;
	for (const method of ["PUT", "DELETE"]) {
		const rejected = await request(
			`${organizationPath}/members/${"x".repeat(129)}`,
			method,
			method === "PUT" ? { role: "viewer" } : undefined
		);
		assert.equal(rejected.status, 400);
		assert.ok(
			productErrorSchema.parse(await rejected.json()).error.fields?.userId
		);
	}

	for (const [path, method] of [
		[organizationPath, "GET"],
		[`${organizationPath}/members`, "GET"],
		[`${organizationPath}/members/viewer`, "PUT"],
		[`${organizationPath}/members/viewer`, "DELETE"],
		[`${organizationPath}/invitations`, "GET"],
		[`${organizationPath}/invitations`, "POST"],
		[`${organizationPath}/invitations/${crypto.randomUUID()}`, "DELETE"],
		["/invitations/accept", "POST"],
		[`${organizationPath}/projects`, "GET"],
		[`${organizationPath}/projects`, "POST"],
	]) {
		assert.equal(
			(await request(path, method, undefined, "")).status,
			401,
			`${method} ${path}`
		);
	}
	assert.equal(
		(await request(`/organizations/${organization.id}/members`)).status,
		200
	);
	const response = await request(
		`/organizations/${organization.id}/projects`,
		"POST",
		{ name: "Launch", description: "" }
	);
	assert.equal(response.status, 201, await response.clone().text());
	projectResponseSchema.parse(await response.json());
	const tooLarge = await request(
		`/organizations/${organization.id}/projects`,
		"POST",
		{ name: "A", description: "x".repeat(20_000) }
	);
	assert.equal(tooLarge.status, 413);
	assert.equal(
		productErrorSchema.parse(await tooLarge.json()).error.code,
		"request_too_large"
	);
	assert.equal(
		(await request(`/organizations/${organization.id}/projects?offset=-1`))
			.status,
		400
	);

	const missing = await request(`/organizations/${crypto.randomUUID()}`);
	assert.equal(missing.status, 404);
	assert.equal(
		observedStatuses.at(-1),
		404,
		"handled domain errors must retain their response status in telemetry"
	);
	const csrf = await app.request(
		`${origin}/api/organizations`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Origin: "https://other.test",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: "No",
			}),
		},
		env,
		context
	);
	assert.equal(csrf.status, 403);
	assert.equal(
		(await app.request(`${origin}/api/health`, {}, env, context)).status,
		200,
		"feature middleware must not protect public health"
	);
});
