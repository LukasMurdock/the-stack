import { sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

// Insertion order of a rowid table, the tiebreak for created_at orderings.
// Rows written in one request share a millisecond, and random UUID ids would
// order them by chance. Do not declare such tables WITHOUT ROWID.
export function insertionOrder(table: SQLiteTable) {
	return sql`${table}.rowid`;
}
