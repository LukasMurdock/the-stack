import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const dialect = new SQLiteSyncDialect();

// Runs Drizzle SQL statements in one D1 batch, which commits atomically. Use it
// when a write and the records it implies must succeed or fail together.
export function batchSql(db: D1Database, statements: SQL[]) {
	return db.batch(
		statements.map((statement) => {
			const query = dialect.sqlToQuery(statement);
			return db.prepare(query.sql).bind(...query.params);
		})
	);
}
