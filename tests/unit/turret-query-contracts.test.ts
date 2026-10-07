import assert from "node:assert/strict";
import test from "node:test";
import {
	turretListPageSchema,
	turretBreadcrumbPageSchema,
	turretSpanPageSchema,
} from "../../src/contracts/turret-pagination";
import {
	turretTimestampMsSchema,
	turretTimeRangeSchema,
} from "../../src/contracts/turret-time-range";

test("pagination contracts accept their boundaries and reject malformed or unbounded pages", () => {
	for (const [schema, maximum, defaultLimit] of [
		[turretListPageSchema, 200, 50],
		[turretBreadcrumbPageSchema, 200, 200],
		[turretSpanPageSchema, 5000, 5000],
	] as const) {
		assert.deepEqual(schema.parse({}), { limit: defaultLimit, offset: 0 });
		assert.deepEqual(
			schema.parse({ limit: String(maximum), offset: "100000" }),
			{
				limit: maximum,
				offset: 100000,
			}
		);
		assert.deepEqual(schema.parse({ limit: 1, offset: 0 }), {
			limit: 1,
			offset: 0,
		});
		for (const limit of [-1, 0, "nope", 1.5, Infinity, maximum + 1])
			assert.equal(
				schema.safeParse({ limit }).success,
				false,
				`limit=${limit}`
			);
		for (const offset of [-1, 100001, 1.5, "nope", Infinity])
			assert.equal(
				schema.safeParse({ offset }).success,
				false,
				`offset=${offset}`
			);
	}
});

test("time contracts preserve epoch milliseconds and reject invalid or empty ranges", () => {
	for (const value of [0, 8640000000000000]) {
		assert.equal(turretTimestampMsSchema.parse(value), value);
		assert.equal(turretTimestampMsSchema.parse(String(value)), value);
	}
	for (const value of ["nope", "Infinity", -1, 1.5, "", 8640000000000001])
		for (const field of ["from", "to"])
			assert.equal(
				turretTimeRangeSchema.safeParse({ [field]: value }).success,
				false
			);
	assert.deepEqual(turretTimeRangeSchema.parse({ from: "1", to: "2" }), {
		from: 1,
		to: 2,
	});
	assert.deepEqual(turretTimeRangeSchema.parse({ to: "2" }), { to: 2 });
	assert.deepEqual(turretTimeRangeSchema.parse({}), {});
	for (const to of [0, 1])
		assert.equal(
			turretTimeRangeSchema.safeParse({ from: 1, to }).success,
			false
		);
});
