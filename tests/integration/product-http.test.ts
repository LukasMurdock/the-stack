import assert from "node:assert/strict";
import test from "node:test";
import { organizationResponseSchema } from "../../src/contracts/organizations";
import { productErrorSchema } from "../../src/contracts/operation";
import {
	executionContext as context,
	origin,
	signedInApi,
} from "../helpers/product-http";

test("HTTP authentication, validation, typed outcomes and resource routes work together", async (t) => {
	const { f, env, app, token, request, observedStatuses } =
		await signedInApi();
	t.after(() => f.sqlite.close());
	assert.equal(
		(await request("/organizations", "GET", undefined, "")).status,
		401
	);
	for (const [path, method] of [
		["/internal/turret/health", "GET"],
		["/internal/turret/features", "PUT"],
		["/internal/turret/compliance", "PUT"],
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
	const tooLarge = await request("/organizations", "POST", {
		name: "x".repeat(20_000),
	});
	assert.equal(tooLarge.status, 413);
	assert.equal(
		productErrorSchema.parse(await tooLarge.json()).error.code,
		"request_too_large"
	);
	assert.equal(
		(await request(`/organizations/${organization.id}/members?offset=-1`))
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
