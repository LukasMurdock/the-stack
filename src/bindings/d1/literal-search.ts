import { sql, type SQLWrapper } from "drizzle-orm";

// SQLite requires the pattern encoding and ESCAPE declaration together.
export function literalContains(column: SQLWrapper, input: string) {
	const pattern = `%${input.replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
	return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
