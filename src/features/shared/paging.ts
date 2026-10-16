import { sql } from "drizzle-orm";
import { PAGE_SIZE, type PageInfo } from "../../contracts/pagination";

// Select this as `matched` in a paged list. SQLite counts window rows before
// LIMIT and OFFSET, so the total follows the same filters and access checks.
export const matchedRows = sql<number>`count(*) over ()`.mapWith(Number);

export type Page<Row> = { rows: Row[]; page: PageInfo };

type PageQuery<Row> = {
	limit(limit: number): { offset(offset: number): PromiseLike<Row[]> };
};

// One page of a list query that selects `matched: matchedRows`.
export async function readPage<Row extends { matched: number }>(
	query: PageQuery<Row>,
	offset: number
): Promise<Page<Omit<Row, "matched">>> {
	const rows = await query.limit(PAGE_SIZE).offset(offset);
	// A page past the end has no row to carry the count; read it from the first.
	const [first] =
		rows.length || !offset ? rows : await query.limit(1).offset(0);
	return {
		rows: rows.map(({ matched: _matched, ...row }) => row),
		page: { offset, total: first?.matched ?? 0 },
	};
}
