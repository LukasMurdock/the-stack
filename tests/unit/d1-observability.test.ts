import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import {
	wrapD1Database,
	type D1Span,
} from "../../src/worker/observability/d1Proxy";

function fixture() {
	const spans: D1Span[] = [];
	const sqlite = new Database(":memory:");
	sqlite.exec(
		"CREATE TABLE users (email TEXT, age INTEGER); INSERT INTO users VALUES ('secret', 50)"
	);
	const db = wrapD1Database({
		db: createSqliteD1(sqlite),
		dbName: "CORE_DB",
		collector: {
			push(span) {
				spans.push(span);
			},
		},
	});
	return { sqlite, db, spans };
}

test("D1 capture survives chained binds and never captures bound values", async (t) => {
	const { sqlite, db, spans } = fixture();
	t.after(() => sqlite.close());
	const before = Date.now();
	const result = await db
		.prepare("SELECT * FROM users WHERE email = ? AND age > 42")
		.bind("private@example.com")
		.bind("secret")
		.all();
	assert.deepEqual(result.results, [{ email: "secret", age: 50 }]);
	assert.equal(spans.length, 1);
	assert.equal(spans[0].rowsRead, 1);
	assert.equal(
		spans[0].sqlShape,
		"SELECT * FROM users WHERE email = ? AND age > ?"
	);
	assert.ok(spans[0].ts >= before);
	assert.ok(!JSON.stringify(spans).includes("secret"));
});

test("D1 batches unwrap native statements and capture each result once", async (t) => {
	const { sqlite, db, spans } = fixture();
	t.after(() => sqlite.close());
	await db.batch([
		db.prepare("SELECT ?").bind(1),
		db.prepare("SELECT ?").bind(2),
	]);
	assert.equal(spans.length, 2);
	assert.equal(
		spans.reduce((sum, span) => sum + (span.rowsRead ?? 0), 0),
		2
	);
});

test("D1 errors preserve rejection and first/raw do not mistake user data for metadata", async (t) => {
	const { sqlite, db, spans } = fixture();
	t.after(() => sqlite.close());
	await assert.rejects(
		db.prepare("SELECT * FROM missing_table").run(),
		/no such table/
	);
	assert.equal(spans[0].kind, "d1.error");
	await db.prepare(`SELECT '{"rows_read":999}' AS meta`).first();
	await db.prepare("SELECT 2").raw();
	assert.equal(spans[1].rowsRead, undefined);
	assert.equal(spans[2].rowsRead, undefined);
	await assert.rejects(
		db.batch([
			db.prepare("SELECT * FROM missing_table"),
			db.prepare("SELECT 1"),
		]),
		/no such table/
	);
	assert.equal(spans.length, 4);
	assert.equal(spans[3].sqlShape, "batch");
});
