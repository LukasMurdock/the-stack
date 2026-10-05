import { isRecord } from "../../src/lib/isRecord";
import assert from "node:assert/strict";
import type Database from "better-sqlite3";

// Implements the D1 API over one SQLite connection, including atomic batches.
export function createSqliteD1(sqlite: Database.Database): D1Database {
	const nativeStatements = new WeakSet<D1PreparedStatement>();
	class Statement implements D1PreparedStatement {
		constructor(
			readonly sql: string,
			readonly values: unknown[] = []
		) {
			nativeStatements.add(this);
		}
		bind(...values: unknown[]): Statement {
			assert.ok(values.length <= 100, "D1 parameter limit exceeded");
			return new Statement(this.sql, values);
		}
		first<T = unknown>(column: string): Promise<T | null>;
		first<T = Record<string, unknown>>(): Promise<T | null>;
		async first<T>(column?: string): Promise<T | null> {
			const row = sqlite
				.prepare<unknown[], Record<string, unknown>>(this.sql)
				.get(...this.values);
			const value = row ? (column ? row[column] : row) : null;
			// SAFETY: like D1's generic first(), T is the caller's SQL result contract; SQLite supplies the selected row or column and missing rows become null.
			return value as T | null;
		}
		execute<T>(): D1Result<T> {
			const prepared = sqlite.prepare(this.sql);
			const rows: unknown[] = prepared.reader
				? prepared.all(...this.values)
				: [];
			const write = prepared.reader
				? undefined
				: prepared.run(...this.values);
			return {
				success: true,
				// SAFETY: D1's generic row type is supplied by the SQL caller; this adapter returns exactly SQLite's rows without transforming their fields.
				results: rows as T[],
				meta: {
					duration: 0,
					size_after: 0,
					rows_read: rows.length,
					rows_written: write?.changes ?? 0,
					last_row_id: Number(write?.lastInsertRowid ?? 0),
					changed_db: Boolean(write?.changes),
					changes: write?.changes ?? 0,
				},
			};
		}
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			return this.execute<T>();
		}
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			return this.execute<T>();
		}
		raw<T = unknown[]>(options: {
			columnNames: true;
		}): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		async raw<T>(options?: {
			columnNames?: boolean;
		}): Promise<T[] | [string[], ...T[]]> {
			const prepared = sqlite.prepare(this.sql);
			// SAFETY: raw() returns SQLite's positional row arrays; T describes the tuple selected by the caller's SQL, just as in D1's raw API.
			const rows = prepared.raw().all(...this.values) as T[];
			return options?.columnNames
				? [prepared.columns().map((column) => column.name), ...rows]
				: rows;
		}
	}
	const db: D1Database = {
		prepare: (sql) => new Statement(sql),
		async batch<T>(
			statements: D1PreparedStatement[]
		): Promise<D1Result<T>[]> {
			return sqlite.transaction(() =>
				statements.map((statement) => {
					assert.ok(
						statement instanceof Statement &&
							nativeStatements.has(statement),
						"Batch requires native statements from this database"
					);
					return statement.execute<T>();
				})
			)();
		},
		async exec(sql) {
			sqlite.exec(sql);
			return { count: 1, duration: 0 };
		},
		withSession() {
			return {
				prepare: db.prepare,
				batch: db.batch,
				getBookmark: () => null,
			};
		},
		async dump() {
			return Uint8Array.from(sqlite.serialize()).buffer;
		},
	};
	return db;
}

export function readSqlRow(
	sqlite: Database.Database,
	sql: string
): Record<string, unknown> {
	const row = sqlite.prepare(sql).get();
	assert.ok(isRecord(row), "Expected one SQL result row");
	return row;
}
