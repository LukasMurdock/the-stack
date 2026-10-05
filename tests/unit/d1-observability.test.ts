import assert from "node:assert/strict";
import test from "node:test";
import {
	wrapD1Database,
	type D1Span,
} from "../../src/worker/observability/d1Proxy";

class Statement {
	constructor(
		readonly sql: string,
		readonly values: unknown[] = []
	) {}
	bind(...values: unknown[]) {
		return new Statement(this.sql, values);
	}
	async all() {
		if (this.sql === "FAIL") throw new Error("database unavailable");
		return {
			results: [this.values],
			meta: { rows_read: 3, rows_written: 1 },
		};
	}
	async run() {
		return this.all();
	}
	async raw() {
		return [this.values];
	}
	async first() {
		return { meta: { rows_read: 999 }, value: this.values[0] };
	}
}

function fixture() {
	const spans: D1Span[] = [];
	const original = {
		prepare(sql: string) {
			return new Statement(sql);
		},
		async batch(statements: Statement[]) {
			assert.ok(
				statements.every((statement) => statement instanceof Statement)
			);
			return Promise.all(statements.map((statement) => statement.all()));
		},
	};
	const db = wrapD1Database({
		db: original as never,
		dbName: "CORE_DB",
		collector: {
			push(span) {
				spans.push(span);
			},
		},
	});
	return { db, spans };
}

test("D1 capture survives chained binds and never captures bound values", async () => {
	const { db, spans } = fixture();
	const before = Date.now();
	const result = await db
		.prepare("SELECT * FROM users WHERE email = ? AND age > 42")
		.bind("private@example.com")
		.bind("secret")
		.all();
	assert.deepEqual(result.results, [["secret"]]);
	assert.equal(spans.length, 1);
	assert.equal(spans[0].rowsRead, 3);
	assert.equal(
		spans[0].sqlShape,
		"SELECT * FROM users WHERE email = ? AND age > ?"
	);
	assert.ok(spans[0].ts >= before);
	assert.ok(!JSON.stringify(spans).includes("secret"));
});

test("D1 batches unwrap native statements and capture each result once", async () => {
	const { db, spans } = fixture();
	await db.batch([
		db.prepare("SELECT 1").bind(1),
		db.prepare("SELECT 2").bind(2),
	]);
	assert.equal(spans.length, 2);
	assert.equal(
		spans.reduce((sum, span) => sum + (span.rowsRead ?? 0), 0),
		6
	);
});

test("D1 errors preserve rejection and first/raw do not mistake user data for metadata", async () => {
	const { db, spans } = fixture();
	await assert.rejects(
		db.prepare("FAIL").bind(1).run(),
		/database unavailable/
	);
	assert.equal(spans[0].kind, "d1.error");
	await db.prepare("SELECT 1").bind(1).first();
	await db.prepare("SELECT 2").raw();
	assert.equal(spans[1].rowsRead, undefined);
	assert.equal(spans[2].rowsRead, undefined);
	await assert.rejects(
		db.batch([db.prepare("FAIL"), db.prepare("SELECT 1")]),
		/database unavailable/
	);
	assert.equal(spans.length, 4);
	assert.equal(spans[3].sqlShape, "batch");
});
