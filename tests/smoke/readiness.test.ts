import assert from "node:assert/strict";
import test from "node:test";
import { routes } from "../../src/worker/api/routes/readiness";
import { productFixture } from "../helpers/product";
import { testBindings, unavailableD1 } from "../helpers/worker";
import { z } from "zod";

const readinessSchema = z.object({ ok: z.boolean(), email: z.unknown() });
// Resolved by the Worker entry; readiness only checks a value is present.
const BETTER_AUTH_SECRET = "readiness-secret-at-least-thirty-two-characters";

test("readiness requires the migrated database and never exposes database errors", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const ready = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding, BETTER_AUTH_SECRET })
	);
	assert.equal(ready.status, 200);
	assert.equal(ready.headers.get("cache-control"), "no-store");
	assert.equal(readinessSchema.parse(await ready.json()).ok, true);
	f.sqlite.exec("drop table invitations");
	const unmigrated = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding, BETTER_AUTH_SECRET })
	);
	assert.equal(unmigrated.status, 503);
	assert.equal(readinessSchema.parse(await unmigrated.json()).ok, false);
	const unavailable = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({
			CORE_DB: unavailableD1("private binding details"),
			BETTER_AUTH_SECRET,
		})
	);
	assert.equal(unavailable.status, 503);
	const unavailableBody = JSON.stringify(await unavailable.json());
	assert.equal(readinessSchema.parse(JSON.parse(unavailableBody)).ok, false);
	assert.ok(!unavailableBody.includes("private binding details"));
});

test("readiness reports what email can do without failing the app", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	async function emailStatus(bindings: Parameters<typeof testBindings>[0]) {
		const response = await routes.request(
			"http://local.test/readiness",
			{},
			testBindings({
				CORE_DB: f.binding,
				BETTER_AUTH_SECRET,
				...bindings,
			})
		);
		assert.equal(response.status, 200, "email never decides readiness");
		return z.object({ email: z.unknown() }).parse(await response.json())
			.email;
	}
	assert.deepEqual(
		await emailStatus({ APP_ENV: "local", EMAIL_TRANSPORT: "log" }),
		{ delivery: "log_only" }
	);
	assert.deepEqual(
		await emailStatus({
			APP_ENV: "production",
			EMAIL_TRANSPORT: "cloudflare",
			EMAIL_FROM: "noreply@your-app.example",
		}),
		{
			delivery: "unavailable",
			reason: "EMAIL_FROM uses the placeholder domain your-app.example.",
			disabled: ["invitations", "password reset", "email verification"],
		}
	);
	assert.deepEqual(
		await emailStatus({
			APP_ENV: "production",
			EMAIL_TRANSPORT: "resend",
			EMAIL_FROM: "Team <noreply@mail.company.com>",
			RESEND_API_KEY: "re_live_key",
		}),
		{ delivery: "provider", transport: "resend" }
	);
});

test("readiness reports whether FLAGS is bound; without it defaults are served", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	async function flagsStatus(bindings: Parameters<typeof testBindings>[0]) {
		const response = await routes.request(
			"http://local.test/readiness",
			{},
			testBindings({
				CORE_DB: f.binding,
				BETTER_AUTH_SECRET,
				...bindings,
			})
		);
		assert.equal(response.status, 200, "flags never decide readiness");
		return z.object({ flags: z.unknown() }).parse(await response.json())
			.flags;
	}
	assert.deepEqual(await flagsStatus({}), {
		binding: "missing",
		serving: "defaults",
	});
	// Readiness only checks that the binding exists; it evaluates nothing.
	const unused = () => Promise.reject(new Error("not evaluated"));
	assert.deepEqual(
		await flagsStatus({
			FLAGS: {
				get: unused,
				getValue: unused,
				getDetails: unused,
				getBooleanValue: unused,
				getStringValue: unused,
				getNumberValue: unused,
				getObjectValue: unused,
				getBooleanDetails: unused,
				getStringDetails: unused,
				getNumberDetails: unused,
				getObjectDetails: unused,
			},
		}),
		{ binding: "configured" }
	);
});

test("readiness fails, naming no value, while a required secret is missing", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const response = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding })
	);
	assert.equal(response.status, 503);
	assert.deepEqual(
		z
			.object({
				ok: z.boolean(),
				secrets: z.object({ missingRequired: z.array(z.string()) }),
			})
			.parse(await response.json()),
		{ ok: false, secrets: { missingRequired: ["BETTER_AUTH_SECRET"] } }
	);
});
