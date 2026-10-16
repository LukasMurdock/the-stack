import assert from "node:assert/strict";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import { observeRequest } from "../../src/worker/observability/request";
import type { Bindings } from "../../src/worker/index";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import { productFixture } from "./product";
import { testBindings } from "./worker";

export const origin = "http://localhost:4321";
export const executionContext = {
	waitUntil() {},
	passThroughOnException() {},
	props: {},
};

// The full API behind request observation, with "owner" signed in through
// Better Auth. `request` sends the owner's bearer token unless given another.
export async function signedInApi() {
	const f = productFixture();
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
			executionContext
		);
	}
	return { f, env, app, token, request, observedStatuses };
}
