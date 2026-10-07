import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { APIError } from "better-auth/api";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import type { Bindings } from "../../src/worker/index";
import { createOrganization } from "../../src/features/organizations/operations";
import {
	inviteMember,
	acceptInvitation,
	revokeInvitation,
} from "../../src/features/organizations/invitations";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";

const origin = "http://localhost:4321";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
test("a live invitation permits matching registration, but membership still requires email verification", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const env = testBindings({
		CORE_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "test",
		AUTH_SIGNUP_MODE: "invite_only",
		EMAIL_TRANSPORT: "log",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
	});
	// Password compromise lookup is an external service; all auth/database behavior is real.
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0", {
			headers: { "Content-Type": "text/plain" },
		});
	});
	const organization = await createOrganization(f.actor("owner"), {
		name: "Studio",
	});
	const invitation = await inviteMember(f.actor("owner"), organization.id, {
		email: "new@example.test",
		role: "viewer",
	});
	const app = new Hono<{ Bindings: Bindings }>();
	app.route("/api", api);
	const body = {
		token: invitation.token,
		email: "new@example.test",
		name: "New member",
		password: "Registration-test-password-123!",
	};
	async function register(fields: typeof body, requestOrigin = origin) {
		return app.request(
			`${origin}/api/invitations/register`,
			{
				method: "POST",
				headers: {
					Origin: requestOrigin,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(fields),
			},
			env,
			context
		);
	}
	assert.equal((await register(body, "https://other.test")).status, 403);
	assert.equal(
		(await register({ ...body, email: "wrong@example.test" })).status,
		404
	);
	assert.equal(
		(await register({ ...body, token: crypto.randomUUID() })).status,
		404
	);
	await assert.rejects(
		() =>
			createAuth(env).api.signUpEmail({
				body: {
					email: "uninvited@example.test",
					name: "No",
					password: body.password,
				},
			}),
		APIError
	);
	const response = await register(body);
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const cookies = response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
	assert.ok(cookies);
	const headers = new Headers({ Cookie: cookies, Origin: origin });
	const auth = createAuth(env);
	const session = await auth.api.getSession({ headers });
	assert.ok(session?.user);
	assert.equal(session.user.emailVerified, false);
	await assert.rejects(() =>
		acceptInvitation(f.actor(session.user.id), { token: invitation.token })
	);
	assert.equal(
		f.sqlite
			.prepare<[string], { count: number }>(
				"select count(*) as count from memberships where user_id = ?"
			)
			.get(session.user.id)?.count,
		0
	);
	let verificationUrl: string | undefined;
	t.mock.method(
		console,
		"log",
		(label: string, payload?: { url?: string }) => {
			if (label === "[email:log-only:url]")
				verificationUrl = payload?.url;
		}
	);
	const callbackURL = `${origin}/app/invitations#${invitation.token}`;
	await auth.api.sendVerificationEmail({
		headers,
		body: { email: body.email, callbackURL },
	});
	assert.ok(verificationUrl);
	assert.equal(
		new URL(verificationUrl).searchParams.get("callbackURL"),
		callbackURL
	);
	const verified = await auth.handler(new Request(verificationUrl));
	assert.equal(verified.status, 302);
	assert.equal(verified.headers.get("Location"), callbackURL);
	const joined = await acceptInvitation(f.actor(session.user.id), {
		token: invitation.token,
	});
	assert.equal(joined.role, "viewer");
	const revoked = await inviteMember(f.actor("owner"), organization.id, {
		email: "revoked@example.test",
		role: "viewer",
	});
	await revokeInvitation(f.actor("owner"), organization.id, revoked.id);
	assert.equal(
		(
			await register({
				...body,
				token: revoked.token,
				email: "revoked@example.test",
			})
		).status,
		404
	);
	const expired = await inviteMember(f.actor("owner"), organization.id, {
		email: "expired@example.test",
		role: "viewer",
	});
	f.sqlite
		.prepare("update invitations set expires_at = 0 where id = ?")
		.run(expired.id);
	assert.equal(
		(
			await register({
				...body,
				token: expired.token,
				email: "expired@example.test",
			})
		).status,
		404
	);
});
