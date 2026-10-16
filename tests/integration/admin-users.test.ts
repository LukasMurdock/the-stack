import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import { createAuth } from "../../src/worker/auth";
import { api } from "../../src/worker/api";
import type { Bindings } from "../../src/worker/index";
import {
	STARTING_PASSWORD_LENGTH,
	createdUserResponseSchema,
} from "../../src/contracts/admin-users";
import { productErrorSchema } from "../../src/contracts/operation";
import {
	acceptInvitation,
	inviteMember,
} from "../../src/features/organizations/invitations";
import { createOrganization } from "../../src/features/organizations/operations";
import { productFixture } from "../helpers/product";
import { testBindings } from "../helpers/worker";

const origin = "http://localhost:4321";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const fixturePassword = "Valid-test-password-123!";

// Everything below the HTTP boundary is real: the API router, Better Auth's
// admin plugin and the migrated SQLite database. Only the compromised-password
// lookup, an external service, is answered locally.
async function adminUsersFixture(t: test.TestContext) {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const env = testBindings({
		CORE_DB: f.binding,
		APP_URL: origin,
		APP_ENV: "test",
		TURRET_MODE: "off",
		BETTER_AUTH_SECRET: "integration-secret-at-least-thirty-two-characters",
		PRODUCT_NAME: "Test",
		EMAIL_TRANSPORT: "log",
	});
	t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
		assert.match(
			String(url),
			/^https:\/\/api\.pwnedpasswords\.com\/range\//
		);
		return new Response("00000000000000000000000000000000000:0");
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
	async function tokenFor(email: string, password = fixturePassword) {
		const signedIn = await auth.api.signInEmail({
			body: { email, password },
			headers: new Headers({ Origin: origin }),
		});
		return signedIn.token;
	}
	const app = new Hono<{ Bindings: Bindings }>();
	app.route("/api", api);
	function createUser(
		body: unknown,
		options: { token?: string; origin?: string } = {}
	) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Origin: options.origin ?? origin,
		};
		if (options.token) headers.Authorization = `Bearer ${options.token}`;
		return app.request(
			`${origin}/api/internal/users`,
			{ method: "POST", headers, body: JSON.stringify(body) },
			env,
			context
		);
	}
	return { f, auth, tokenFor, createUser };
}

const validInput = {
	name: "New Designer",
	email: "New.Designer@Example.test",
	role: "user",
	emailVerification: "verified",
} as const;

test("only an administrator on the app origin can create users", async (t) => {
	const { tokenFor, createUser, f } = await adminUsersFixture(t);
	const anonymous = await createUser(validInput);
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.headers.get("Cache-Control"), "no-store");
	assert.equal(
		productErrorSchema.parse(await anonymous.json()).error.code,
		"unauthorized"
	);
	const viewer = await createUser(validInput, {
		token: await tokenFor("viewer@example.test"),
	});
	assert.equal(viewer.status, 403);
	assert.equal(
		productErrorSchema.parse(await viewer.json()).error.code,
		"forbidden"
	);
	const crossSite = await createUser(validInput, {
		token: await tokenFor("owner@example.test"),
		origin: "https://attacker.test",
	});
	assert.equal(crossSite.status, 403);
	const count = f.sqlite
		.prepare<[], { count: number }>(
			"select count(*) as count from auth_user"
		)
		.get()?.count;
	assert.equal(count, 4, "no rejected request created a user");
});

test("create-user input is validated and strict", async (t) => {
	const { tokenFor, createUser } = await adminUsersFixture(t);
	const token = await tokenFor("owner@example.test");
	const invalid: ReadonlyArray<readonly [string, unknown, string]> = [
		["empty name", { ...validInput, name: "   " }, "name"],
		["long name", { ...validInput, name: "x".repeat(121) }, "name"],
		["malformed email", { ...validInput, email: "not-an-email" }, "email"],
		[
			"long email",
			{ ...validInput, email: `${"a".repeat(250)}@x.test` },
			"email",
		],
		["unknown role", { ...validInput, role: "owner" }, "role"],
		[
			"missing verification",
			{ ...validInput, emailVerification: undefined },
			"emailVerification",
		],
		[
			"unknown verification",
			{ ...validInput, emailVerification: "yes" },
			"emailVerification",
		],
		[
			"client-chosen password",
			{ ...validInput, password: "Chosen-password-123!" },
			"",
		],
		["extra user data", { ...validInput, data: { banned: true } }, ""],
	];
	for (const [label, body, field] of invalid) {
		const response = await createUser(body, { token });
		assert.equal(response.status, 400, label);
		const { error } = productErrorSchema.parse(await response.json());
		assert.equal(error.code, "invalid_input", label);
		if (field)
			assert.ok(
				error.fields?.[field],
				`${label}: ${JSON.stringify(error.fields)}`
			);
	}
	const duplicate = await createUser(
		{ ...validInput, email: "VIEWER@example.test" },
		{ token }
	);
	assert.equal(duplicate.status, 400);
	assert.match(
		productErrorSchema.parse(await duplicate.json()).error.fields?.email ??
			"",
		/already exists/
	);
	const tooLarge = await createUser(
		{ ...validInput, name: "x".repeat(20_000) },
		{ token }
	);
	assert.equal(tooLarge.status, 413);
});

test("an administrator creates a user who signs in with the starting password shown once", async (t) => {
	const { f, auth, tokenFor, createUser } = await adminUsersFixture(t);
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
	const response = await createUser(validInput, {
		token: await tokenFor("owner@example.test"),
	});
	assert.equal(response.status, 201, await response.clone().text());
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const created = createdUserResponseSchema.parse(await response.json());
	assert.equal(created.user.email, "new.designer@example.test");
	assert.equal(created.user.role, "user");
	assert.equal(created.startingPassword.length, STARTING_PASSWORD_LENGTH);
	const signedIn = await auth.api.signInEmail({
		body: {
			email: "new.designer@example.test",
			password: created.startingPassword,
		},
		headers: new Headers({ Origin: origin }),
	});
	assert.equal(signedIn.user.id, created.user.id);
	assert.equal(signedIn.user.emailVerified, true);
	// Verified by an administrator, the person can join an organization by
	// invitation without a verification email.
	const organization = await createOrganization(f.actor("owner"), {
		name: "Studio",
	});
	const invitation = await inviteMember(f.actor("owner"), organization.id, {
		email: "new.designer@example.test",
		role: "viewer",
	});
	const joined = await acceptInvitation(f.actor(created.user.id), {
		token: invitation.token,
	});
	assert.equal(joined.role, "viewer");
	// The password exists only as Better Auth's hash, and no log line has it.
	const dump = JSON.stringify(
		f.sqlite.prepare("select * from auth_account").all()
	);
	assert.ok(!dump.includes(created.startingPassword));
	assert.ok(!logged.some((line) => line.includes(created.startingPassword)));
	assert.ok(
		logged.some((line) => line.includes("admin.user_created")),
		logged.join("\n")
	);
});

test("an unverified user can sign in but cannot accept invitations until verified", async (t) => {
	const { f, auth, tokenFor, createUser } = await adminUsersFixture(t);
	const response = await createUser(
		{ ...validInput, role: "admin", emailVerification: "unverified" },
		{ token: await tokenFor("owner@example.test") }
	);
	assert.equal(response.status, 201);
	const created = createdUserResponseSchema.parse(await response.json());
	const signedIn = await auth.api.signInEmail({
		body: {
			email: validInput.email.toLowerCase(),
			password: created.startingPassword,
		},
		headers: new Headers({ Origin: origin }),
	});
	assert.equal(signedIn.user.emailVerified, false);
	assert.equal(
		f.sqlite
			.prepare<[string], { role: string }>(
				"select role from auth_user where id = ?"
			)
			.get(created.user.id)?.role,
		"admin"
	);
	const organization = await createOrganization(f.actor("owner"), {
		name: "Studio",
	});
	const invitation = await inviteMember(f.actor("owner"), organization.id, {
		email: validInput.email.toLowerCase(),
		role: "viewer",
	});
	await assert.rejects(() =>
		acceptInvitation(f.actor(created.user.id), { token: invitation.token })
	);
});
