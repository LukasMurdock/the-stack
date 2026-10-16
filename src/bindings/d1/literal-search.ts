import { sql, type SQLWrapper } from "drizzle-orm";

// Case-insensitive literal substring match. instr() treats input as plain text,
// and D1 rejects LIKE patterns over 50 bytes, so user input never becomes one.
// lower() folds ASCII case, as SQLite's LIKE does.
export function literalContains(column: SQLWrapper, input: string) {
	return sql`instr(lower(${column}), lower(${input})) > 0`;
}
