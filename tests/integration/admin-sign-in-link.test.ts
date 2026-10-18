import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import worker, { type Bindings } from "../../src/worker/index";
import {
	SIGN_IN_LINK_COOLDOWN_SECONDS,
	signInLinkCooldownKey,
} from "../../src/worker/api/routes/admin-sign-in-link";
import { signInLinkResponseSchema } from "../../src/contracts/admin-users";
import {
	EMAIL_LAST_SEND_KEY,
	emailSendOutcomeSchema,
} from "../../src/contracts/email-send-outcome";
import { productErrorSchema } from "../../src/contracts/operation";
import { fakeKv } from "../helpers/fake-kv";
import { productFixture } from "../helpers/product";
import { testBindings, untracedExecutionContext } from "../helpers/worker";

const origin = "http://localhost:4321";
const fixturePassword = "Valid-test-password-123!";
const URL_PATTERN = /https?:\/\/\S+/;

type SentEmail = { to: string; subject: string; text: string };

// Real API router, Worker entry, Better Auth and migrated SQLite. Only the
// Cloudflare send_email binding, KV and the compromised-password lookup (an
// external service) are fakes. "editor" has no password, like an account
// created for someone who never received its starting password.
async function signInLinkFixture(
	t: test.TestContext,
	options: { email: "configured" | "missing" } = { email: "configured" }
) {
	const logged: string[] = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		t.mock.method(console, method, (...args: unknown[]) => {
			logged.push(
				args
					.map((arg) =>
						typeof arg === "string" ? arg : JSON.stringify(arg)
					)
					.join(" ")
			);
		});
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0");
	});
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const store = fakeKv();
	const sent: SentEmail[] = [];
	const env = testBindings({
		CORE_DB: f.binding,
		CORE_KV: store.binding,
		APP_URL: origin,
		APP_ENV: "production",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "cloudflare",
		EMAIL_FROM: "notifications@mail.company.com",
		SEND_EMAIL:
			options.email === "missing"
				? undefined
				: {
						async send(message) {
							if (!("subject" in message))
								throw new Error("Expected email builder");
							sent.push({
								to: String(message.to),
								subject: message.subject,
								text: message.text ?? "",
							});
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
	const headers = new Headers({ Origin: origin });
	// Collects background work (the email send) so a test can wait for it.
	const pending: Promise<unknown>[] = [];
	const context: ExecutionContext = {
		...untracedExecutionContext(),
		waitUntil(promise) {
			pending.push(promise);
		},
	};
	async function settled() {
		await Promise.all(pending.splice(0));
	}
	const app = new Hono<{ Bindings: Bindings }>();
	app.route("/api", api);
	async function token(email: string) {
		const signedIn = await auth.api.signInEmail({
			body: { email, password: fixturePassword },
			headers,
		});
		return signedIn.token;
	}
	async function sendLink(
		userId: string,
		request: { token?: string; origin?: string } = {}
	) {
		const requestHeaders: Record<string, string> = {
			Origin: request.origin ?? origin,
		};
		if (request.token)
			requestHeaders.Authorization = `Bearer ${request.token}`;
		const response = await app.request(
			`${origin}/api/internal/users/${encodeURIComponent(userId)}/sign-in-link`,
			{ method: "POST", headers: requestHeaders },
			env,
			context
		);
		await settled();
		return response;
	}
	// The public endpoint as the deployed Worker serves it.
	async function publicReset(
		email: string,
		extra: { readonly type?: string } = {}
	) {
		const response = await worker.fetch(
			new Request(`${origin}/api/auth/request-password-reset`, {
				method: "POST",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
					"X-Email-Type": "sign-in-link",
				},
				body: JSON.stringify({
					email,
					redirectTo: `${origin}/app/reset-password`,
					...extra,
				}),
			}),
			env,
			context
		);
		await settled();
		return response;
	}
	return {
		f,
		auth,
		headers,
		store,
		sent,
		logged,
		token,
		sendLink,
		publicReset,
	};
}

async function errorOf(response: Response) {
	return productErrorSchema.parse(await response.json()).error;
}

test("only an administrator on the app origin can send a sign-in link", async (t) => {
	const { token, sendLink, sent, store } = await signInLinkFixture(t);
	const anonymous = await sendLink("editor");
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.headers.get("Cache-Control"), "no-store");
	assert.equal((await errorOf(anonymous)).code, "unauthorized");
	const refused = await sendLink("editor", {
		token: await token("viewer@example.test"),
	});
	assert.equal(refused.status, 403);
	assert.equal((await errorOf(refused)).code, "forbidden");
	const crossSite = await sendLink("editor", {
		token: await token("owner@example.test"),
		origin: "https://attacker.test",
	});
	assert.equal(crossSite.status, 403);
	assert.equal(sent.length, 0, "no refused request sent email");
	assert.equal(store.stored.has(signInLinkCooldownKey("editor")), false);
});

test("an administrator emails a user without a password a sign-in link they use to set a password and sign in", async (t) => {
	const { auth, headers, store, sent, logged, token, sendLink } =
		await signInLinkFixture(t);
	const admin = await token("owner@example.test");
	const response = await sendLink("editor", { token: admin });
	assert.equal(response.status, 202, await response.clone().text());
	assert.deepEqual(signInLinkResponseSchema.parse(await response.json()), {
		sentTo: "editor@example.test",
	});
	assert.equal(sent.length, 1);
	const [email] = sent;
	assert.equal(email.to, "editor@example.test");
	assert.equal(email.subject, "Set your password for Test");
	assert.match(email.text, /An administrator of Test sent you this link/);
	assert.doesNotMatch(email.text, /reset the password|Reset password/);
	// The provider outcome is recorded under its own type.
	const lastSend = emailSendOutcomeSchema.parse(
		JSON.parse(store.stored.get(EMAIL_LAST_SEND_KEY) ?? "null")
	);
	assert.equal(lastSend.outcome, "accepted");
	assert.equal(lastSend.type, "sign-in-link");

	const link = email.text.match(URL_PATTERN)?.[0];
	assert.ok(link, email.text);
	assert.match(link, /^http:\/\/localhost:4321\/api\/auth\/reset-password\//);
	const redirected = await auth.handler(new Request(link));
	assert.equal(redirected.status, 302);
	const callback = new URL(redirected.headers.get("Location") ?? "");
	assert.equal(callback.pathname, "/app/reset-password");
	const resetToken = callback.searchParams.get("token");
	assert.ok(resetToken);
	const password = "Chosen-after-link-492873!";
	await auth.api.resetPassword({
		headers,
		body: { token: resetToken, newPassword: password },
	});
	const signedIn = await auth.api.signInEmail({
		headers,
		body: { email: "editor@example.test", password },
	});
	assert.equal(signedIn.user.id, "editor");

	// The audit line names ids only: no address, link or token.
	const audit = logged.filter((line) =>
		line.includes("admin.sign_in_link_sent")
	);
	assert.equal(audit.length, 1, logged.join("\n"));
	assert.match(audit[0], /"actorId":"owner"/);
	assert.match(audit[0], /"id":"editor"/);
	assert.doesNotMatch(audit[0], /editor@example\.test|reset-password/);
	assert.ok(!logged.some((line) => line.includes(resetToken)));
});

test("sign-in links are refused inside the cooldown, for unknown users, and for banned users", async (t) => {
	const { f, store, sent, token, sendLink } = await signInLinkFixture(t);
	const admin = await token("owner@example.test");
	assert.equal((await sendLink("editor", { token: admin })).status, 202);
	const again = await sendLink("editor", { token: admin });
	assert.equal(again.status, 429);
	const retryAfterSeconds = Number(again.headers.get("Retry-After"));
	assert.ok(
		retryAfterSeconds > 0 &&
			retryAfterSeconds <= SIGN_IN_LINK_COOLDOWN_SECONDS,
		String(retryAfterSeconds)
	);
	const limited = await errorOf(again);
	assert.equal(limited.code, "rate_limited");
	assert.match(
		limited.message,
		new RegExp(`Try again in ${retryAfterSeconds} seconds`)
	);
	assert.equal(sent.length, 1, "the refused click sent nothing");
	// The cooldown is per user.
	assert.equal((await sendLink("outsider", { token: admin })).status, 202);
	// Once it has passed, the next click sends again.
	store.stored.set(
		signInLinkCooldownKey("editor"),
		String(Date.now() - SIGN_IN_LINK_COOLDOWN_SECONDS * 1_000)
	);
	assert.equal((await sendLink("editor", { token: admin })).status, 202);
	assert.equal(sent.length, 3);

	const unknown = await sendLink("no-such-user", { token: admin });
	assert.equal(unknown.status, 404);
	assert.equal((await errorOf(unknown)).code, "not_found");

	f.sqlite
		.prepare("update auth_user set banned = 1 where id = 'viewer'")
		.run();
	const banned = await sendLink("viewer", { token: admin });
	assert.equal(banned.status, 409);
	assert.match((await errorOf(banned)).message, /banned/);
	// An expired ban no longer applies (Better Auth lifts it at sign-in).
	f.sqlite
		.prepare("update auth_user set ban_expires = ? where id = 'viewer'")
		.run(Date.now() - 1_000);
	assert.equal((await sendLink("viewer", { token: admin })).status, 202);
	assert.equal(sent.length, 4);
});

test("without email configured the link is refused before anything is recorded", async (t) => {
	const { store, token, sendLink } = await signInLinkFixture(t, {
		email: "missing",
	});
	const response = await sendLink("editor", {
		token: await token("owner@example.test"),
	});
	assert.equal(response.status, 503);
	const error = await errorOf(response);
	assert.equal(error.code, "unavailable");
	assert.match(error.message, /SEND_EMAIL binding is missing/);
	assert.equal(store.stored.has(signInLinkCooldownKey("editor")), false);
});

test("the public reset request always sends the ordinary reset email", async (t) => {
	const { sent, store, publicReset } = await signInLinkFixture(t);
	// A client cannot select the administrator's email: there is no header or
	// body field for it, so these extras are ignored.
	const response = await publicReset("viewer@example.test", {
		type: "sign-in-link",
	});
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(sent.length, 1);
	assert.equal(sent[0].to, "viewer@example.test");
	assert.equal(sent[0].subject, "Reset your password for Test");
	assert.doesNotMatch(sent[0].text, /administrator/);
	const lastSend = emailSendOutcomeSchema.parse(
		JSON.parse(store.stored.get(EMAIL_LAST_SEND_KEY) ?? "null")
	);
	assert.equal(lastSend.type, "reset-password");
});
