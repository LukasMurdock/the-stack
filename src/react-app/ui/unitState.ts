// What a Unit's body shows instead of (or as) its rows.
export type UnitState =
	| { kind: "ready" }
	| { kind: "loading" }
	| { kind: "error"; retry: () => void }
	| { kind: "empty"; title: string };

// A list's Unit state from its query: skeleton while loading, retry on
// error, `empty` copy when it has no rows.
export function queryState(
	query: { isPending: boolean; isError: boolean; refetch: () => unknown },
	count: number,
	empty: string
): UnitState {
	if (query.isPending) return { kind: "loading" };
	if (query.isError)
		return { kind: "error", retry: () => void query.refetch() };
	if (count === 0) return { kind: "empty", title: empty };
	return { kind: "ready" };
}

// The empty state for rows already in hand, such as a suspense query's.
export function rowsState(count: number, empty: string): UnitState {
	return count === 0 ? { kind: "empty", title: empty } : { kind: "ready" };
}
