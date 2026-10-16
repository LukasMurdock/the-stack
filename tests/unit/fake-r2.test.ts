import assert from "node:assert/strict";
import test from "node:test";
import {
	FakeR2Bucket,
	R2_DELETE_KEYS_MAX,
	R2_LIST_LIMIT_MAX,
} from "../helpers/fake-r2";

// Route tests trust this fake's R2 semantics, so pin the ones Turret tests
// do not reach: conditions, pagination, bounds, and unsupported features.

test("conditional writes and reads follow R2 etag rules", async () => {
	const bucket = new FakeR2Bucket();
	const createOnly = { onlyIf: { etagDoesNotMatch: "*" } };
	const first = await bucket.put("a", "one", createOnly);
	assert.ok(first);
	assert.equal(await bucket.put("a", "two", createOnly), null);
	assert.equal(bucket.text("a"), "one");
	assert.equal(
		await bucket.put("a", "two", { onlyIf: { etagMatches: "stale" } }),
		null
	);
	assert.ok(
		await bucket.put("a", "two", { onlyIf: { etagMatches: first.etag } })
	);
	const skipped = await bucket.get("a", {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	assert.ok(skipped && !("body" in skipped));
	const body = await bucket.get("a");
	assert.equal(await body?.text(), "two");
	await assert.rejects(async () => body?.text(), /already used/);
	assert.deepEqual(bucket.writtenKeys, ["a", "a"]);
	assert.deepEqual(bucket.readKeys, ["a"]);
	assert.equal(await bucket.get("missing"), null);
	assert.equal(await bucket.head("missing"), null);
});

test("list pages by prefix and cursor within R2's limit", async () => {
	const bucket = new FakeR2Bucket();
	for (const key of ["p/2", "p/1", "p/3", "q/1"]) await bucket.put(key, "");
	const first = await bucket.list({ prefix: "p/", limit: 2 });
	assert.deepEqual(
		first.objects.map((object) => object.key),
		["p/1", "p/2"]
	);
	assert.ok(first.truncated);
	const rest = await bucket.list({ prefix: "p/", cursor: first.cursor });
	assert.deepEqual(
		rest.objects.map((object) => object.key),
		["p/3"]
	);
	assert.equal(rest.truncated, false);
	for (const limit of [0, R2_LIST_LIMIT_MAX + 1, 1.5])
		await assert.rejects(bucket.list({ limit }), RangeError);
	await bucket.list({ limit: R2_LIST_LIMIT_MAX });
});

test("delete is idempotent, bounded, and stops at an injected failure", async () => {
	const bucket = new FakeR2Bucket((key) => {
		if (key === "b") throw new Error("R2 unavailable");
	});
	await bucket.put("a", "");
	await bucket.put("b", "");
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- An R2 bucket, not a Drizzle table.
	await bucket.delete("missing");
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- An R2 bucket, not a Drizzle table.
	await assert.rejects(bucket.delete(["a", "b"]), /R2 unavailable/);
	assert.deepEqual([...bucket.objects.keys()], ["b"]);
	const keys = Array.from({ length: R2_DELETE_KEYS_MAX + 1 }, String);
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- An R2 bucket, not a Drizzle table.
	await assert.rejects(bucket.delete(keys), RangeError);
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- An R2 bucket, not a Drizzle table.
	await new FakeR2Bucket().delete(keys.slice(0, R2_DELETE_KEYS_MAX));
});

test("features the fake does not model throw instead of passing silently", async () => {
	const bucket = new FakeR2Bucket();
	await bucket.put("a", "");
	await assert.rejects(
		bucket.get("a", { range: { offset: 0 } }),
		/does not support range/
	);
	await assert.rejects(
		bucket.put("a", "", { onlyIf: new Headers() }),
		/does not support Headers/
	);
	await assert.rejects(bucket.list({ delimiter: "/" }), /delimiters/);
	assert.throws(() => bucket.resumeMultipartUpload(), /multipart/);
});
