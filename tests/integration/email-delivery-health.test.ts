import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import type { Bindings } from "../../src/worker/index";
import { adminEmailDeliverySchema } from "../../src/contracts/email-send-outcome";
import { productErrorSchema } from "../../src/contracts/operation";
import { fakeKv } from "../helpers/fake-kv";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";

const origin = "http://localhost:4321";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const fixturePassword = "Valid-test-password-123!";
const providerMessage =
	"email sending not authorized for subdomain 'mail.company.com'";

const readinessSchema = z.object({
	ok: z.boolean(),
	email: z.object({
		delivery: z.string(),
		lastSend: z
			.object({
				outcome: z.enum(["accepted", "failed"]),
				atMs: z.number(),
				code: z.string().nullable(),
			})
			.strict()
			.nullable(),
	}),
});

// Real API router, Better Auth and migrated SQLite; only the Cloudflare
// send_email binding and KV are fakes.
async function deliveryFixture(t: test.TestContext) {
	for (const method of ["log", "info", "warn", "error"] as const)
		t.mock.method(console, method, () => {});
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const store = fakeKv();
	const sent: string[] = [];
	let failing = true;
	const env = testBindings({
		CORE_DB: f.binding,
		CORE_KV: store.binding,
		APP_URL: origin,
		APP_ENV: "production",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "cloudflare",
		EMAIL_FROM: "noreply@mail.company.com",
		SEND_EMAIL: {
			async send(message) {
				if (failing)
					throw Object.assign(new Error(providerMessage), {
						code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
					});
				sent.push(String(message.to));
				return { messageId: "accepted-id" };
			},
		},
	});
	f.sqlite
		.prepare("update auth_user set role = 'admin' where id = 'owner'")
		.run();
	const passwordHash = await hashPassword(fixturePassword);
	for (const id of ["owner", "viewer"])
		f.sqlite
			.prepare(
				"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, ?, 'credential', ?, ?, ?)"
			)
			.run(crypto.randomUUID(), id, id, passwordHash, Date.now());
	const auth = createAuth(env);
	const app = new Hono<{ Bindings: Bindings }>();
	app.route("/api", api);
	const headers = new Headers({ Origin: origin });
	return {
		sent,
		setFailing(value: boolean) {
			failing = value;
		},
		async requestReset() {
			// Without an execution context the send completes before returning.
			await auth.api.requestPasswordReset({
				body: {
					email: "owner@example.test",
					redirectTo: `${origin}/app/reset-password`,
				},
				headers,
			});
		},
		async readiness() {
			const response = await app.request(
				`${origin}/api/readiness`,
				{},
				env,
				context
			);
			const text = await response.text();
			return {
				status: response.status,
				text,
				body: readinessSchema.parse(JSON.parse(text)),
			};
		},
		async token(email: string) {
			const signedIn = await auth.api.signInEmail({
				body: { email, password: fixturePassword },
				headers,
			});
			return signedIn.token;
		},
		emailDelivery(token?: string) {
			const requestHeaders: Record<string, string> = { Origin: origin };
			if (token) requestHeaders.Authorization = `Bearer ${token}`;
			return app.request(
				`${origin}/api/internal/email-delivery`,
				{ headers: requestHeaders },
				env,
				context
			);
		},
	};
}

test("a failing provider send shows in readiness without its message and clears on the next accepted send", async (t) => {
	const fixture = await deliveryFixture(t);
	const before = await fixture.readiness();
	assert.equal(before.status, 200);
	assert.equal(before.body.email.delivery, "provider");
	assert.equal(before.body.email.lastSend, null);

	await fixture.requestReset();
	const failed = await fixture.readiness();
	assert.equal(failed.status, 200, "failed delivery never fails readiness");
	assert.equal(failed.body.ok, true);
	assert.equal(failed.body.email.lastSend?.outcome, "failed");
	assert.equal(
		failed.body.email.lastSend?.code,
		"E_SENDER_DOMAIN_NOT_AVAILABLE"
	);
	assert.ok(!failed.text.includes("not authorized"), "message is admin-only");

	fixture.setFailing(false);
	await fixture.requestReset();
	assert.deepEqual(fixture.sent, ["owner@example.test"]);
	const recovered = await fixture.readiness();
	assert.equal(recovered.body.email.lastSend?.outcome, "accepted");
	assert.equal(recovered.body.email.lastSend?.code, null);
});

test("only administrators read the provider message", async (t) => {
	const fixture = await deliveryFixture(t);
	await fixture.requestReset();
	const anonymous = await fixture.emailDelivery();
	assert.equal(anonymous.status, 401);
	assert.equal(
		productErrorSchema.parse(await anonymous.json()).error.code,
		"unauthorized"
	);
	const viewer = await fixture.emailDelivery(
		await fixture.token("viewer@example.test")
	);
	assert.equal(viewer.status, 403);
	assert.equal(
		productErrorSchema.parse(await viewer.json()).error.code,
		"forbidden"
	);
	const admin = await fixture.emailDelivery(
		await fixture.token("owner@example.test")
	);
	assert.equal(admin.status, 200);
	assert.equal(admin.headers.get("Cache-Control"), "no-store");
	const body = adminEmailDeliverySchema.parse(await admin.json());
	assert.deepEqual(body.disabled, [
		"invitations",
		"password reset",
		"email verification",
	]);
	assert.equal(body.lastSend?.outcome, "failed");
	assert.equal(body.lastSend?.type, "reset-password");
	assert.equal(body.lastSend?.provider, "cloudflare");
	assert.equal(body.lastSend?.message, providerMessage);
	assert.ok(!JSON.stringify(body).includes("owner@example.test"));
});
