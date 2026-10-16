import assert from "node:assert/strict";
import test from "node:test";
import { getTableColumns, is } from "drizzle-orm";
import {
	SQLiteTable,
	getTableConfig,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { makeCoreDb } from "../../src/bindings/d1/core/db";
import { makeTurretDb } from "../../src/bindings/d1/turret/db";
import { unavailableD1 } from "../helpers/worker";
import * as core from "../../src/bindings/d1/core/schema";
import * as turret from "../../src/bindings/d1/turret/schema";

// Columns are snake_case in SQL and camelCase in TypeScript, so raw-SQL seeds
// and imports can rely on one convention. Drizzle's `casing: "snake_case"`
// (db.ts and drizzle.config.ts) derives unnamed columns; explicit names must
// follow it by hand.
function snakeCase(key: string) {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

test("every D1 column is the snake_case form of its schema key", () => {
	const mismatches: string[] = [];
	let columnCount = 0;
	for (const value of [...Object.values(core), ...Object.values(turret)]) {
		if (!is(value, SQLiteTable)) continue;
		const table = getTableConfig(value).name;
		for (const [key, column] of Object.entries(getTableColumns(value))) {
			columnCount++;
			if (!column.keyAsName && column.name !== snakeCase(key))
				mismatches.push(`${table}.${key} is "${column.name}"`);
		}
	}
	assert.ok(columnCount > 0, "no schema columns found");
	assert.deepEqual(mismatches, []);
});

test("both databases derive snake_case names for unnamed columns", () => {
	const probe = sqliteTable("probe", { fromStatus: text() });
	const d1 = unavailableD1("SQL is only built, never run.");
	for (const db of [makeCoreDb(d1), makeTurretDb(d1)])
		assert.equal(
			db.select().from(probe).toSQL().sql,
			'select "from_status" from "probe"'
		);
});
