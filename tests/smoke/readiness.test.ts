import assert from "node:assert/strict";
import test from "node:test";
import { routes } from "../../src/worker/api/routes/readiness";
import { productFixture } from "../helpers/product";
import { testBindings, unavailableD1 } from "../helpers/worker";

test("readiness requires the migrated database and never exposes database errors", async (t) => {
	const f = productFixture();
	t.after(() => f.sqlite.close());
	const ready = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding })
	);
	assert.equal(ready.status, 200);
	assert.equal(ready.headers.get("cache-control"), "no-store");
	assert.deepEqual(await ready.json(), { ok: true });
	f.sqlite.exec("drop table projects");
	const withoutExample = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding })
	);
	assert.equal(
		withoutExample.status,
		200,
		"removing the example must not break core readiness"
	);

	f.sqlite.exec("drop table invitations");
	const unmigrated = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: f.binding })
	);
	assert.equal(unmigrated.status, 503);
	assert.deepEqual(await unmigrated.json(), { ok: false });
	const unavailable = await routes.request(
		"http://local.test/readiness",
		{},
		testBindings({ CORE_DB: unavailableD1("private binding details") })
	);
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await unavailable.json(), { ok: false });
});
