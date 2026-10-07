import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { is, Column } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as core from "../../src/bindings/d1/core/schema";
import * as turret from "../../src/bindings/d1/turret/schema";
import { migratedSqlite, migrationDirectory } from "../helpers/migrations";
import { readSqlRow } from "../helpers/sqlite-d1";
import { z } from "zod";

test("full migration chains preserve declared columns, indexes and foreign keys", (t) => {
	for (const [name, schema] of [
		["core", core],
		["turret", turret],
	] as const) {
		const sqlite = migratedSqlite(name);
		t.after(() => sqlite.close());
		for (const table of Object.values(schema)) {
			if (!is(table, SQLiteTable)) continue;
			const config = getTableConfig(table);
			const columns = z
				.array(
					z.object({
						name: z.string(),
						type: z.string(),
						notnull: z.number(),
					})
				)
				.parse(
					sqlite
						.prepare(
							'SELECT name, type, "notnull" FROM pragma_table_info(?)'
						)
						.all(config.name)
				);
			assert.deepEqual(
				columns.map((column) => column.name).sort(),
				config.columns.map((column) => column.name).sort(),
				config.name
			);
			for (const column of config.columns) {
				const actual = columns.find(
					(item) => item.name === column.name
				);
				assert.ok(actual);
				assert.equal(
					actual.type.toLowerCase(),
					column.getSQLType(),
					`${config.name}.${column.name}`
				);
				if (column.notNull)
					assert.equal(
						actual.notnull,
						1,
						`${config.name}.${column.name}`
					);
			}
			const indexes = z
				.array(z.object({ name: z.string(), unique: z.number() }))
				.parse(
					sqlite
						.prepare(
							'SELECT name, "unique" FROM pragma_index_list(?)'
						)
						.all(config.name)
				);
			for (const index of config.indexes) {
				const actual = indexes.find(
					(item) => item.name === index.config.name
				);
				assert.ok(
					actual,
					`${config.name}: missing ${index.config.name}`
				);
				assert.equal(actual.unique, Number(index.config.unique));
				const names = z
					.array(z.object({ name: z.string() }))
					.parse(
						sqlite
							.prepare(
								"SELECT name FROM pragma_index_info(?) ORDER BY seqno"
							)
							.all(actual.name)
					);
				assert.deepEqual(
					names.map((item) => item.name),
					index.config.columns.map((column) => {
						assert.ok(is(column, Column));
						return column.name;
					})
				);
			}
			const foreignKeys = z
				.array(
					z.object({
						table: z.string(),
						from: z.string(),
						to: z.string(),
						on_delete: z.string(),
					})
				)
				.parse(
					sqlite
						.prepare("SELECT * FROM pragma_foreign_key_list(?)")
						.all(config.name)
				);
			for (const foreignKey of config.foreignKeys) {
				const reference = foreignKey.reference();
				for (const [index, column] of reference.columns.entries()) {
					assert.ok(
						foreignKeys.some(
							(actual) =>
								actual.from === column.name &&
								actual.table ===
									getTableConfig(reference.foreignTable)
										.name &&
								actual.to ===
									reference.foreignColumns[index].name &&
								actual.on_delete.toLowerCase() ===
									(foreignKey.onDelete ?? "no action")
						),
						`${config.name}.${column.name}: foreign key mismatch`
					);
				}
			}
		}
	}
});

test("span cutover discards old diagnostics and requires a breadcrumb relationship", (t) => {
	const sqlite = migratedSqlite("turret");
	t.after(() => sqlite.close());
	sqlite.exec(`
		INSERT INTO turret_request_breadcrumbs (id, request_id, session_id, ts, method, path, status, duration_ms, expires_at, created_at)
		VALUES ('one', 'shared', 'session-a', 0, 'GET', '/', 200, 1, 1000, 0);
	`);
	const insert = sqlite.prepare(
		"INSERT INTO turret_request_spans (id, breadcrumb_id, ts, kind, duration_ms, expires_at, created_at) VALUES (?, ?, 0, 'd1', 1, 1000, 0)"
	);
	insert.run("old", "one");
	sqlite.exec(
		readFileSync(
			new URL(
				"0009_span_breadcrumb_identity.sql",
				migrationDirectory("turret")
			),
			"utf8"
		)
	);
	assert.equal(
		readSqlRow(sqlite, "SELECT count(*) AS n FROM turret_request_spans").n,
		0
	);
	assert.throws(() => insert.run("missing", null), /NOT NULL/);
	assert.throws(() => insert.run("orphan", "absent"), /FOREIGN KEY/);
	insert.run("linked", "one");
	sqlite.exec("DELETE FROM turret_request_breadcrumbs WHERE id='one'");
	assert.equal(
		readSqlRow(sqlite, "SELECT count(*) AS n FROM turret_request_spans").n,
		0
	);
});
