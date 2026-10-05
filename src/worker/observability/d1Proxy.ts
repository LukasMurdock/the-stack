import { normalizeSqlShape } from "./sqlShape";

type D1Span = {
	kind: "d1.query" | "d1.error";
	db: "CORE_DB" | "TURRET_DB";
	ts: number;
	durationMs: number;
	sqlShape: string;
	rowsRead?: number;
	rowsWritten?: number;
	errorMessage?: string;
};

type D1SpanCollector = { push(span: D1Span): void };
type QueryResult = { meta?: { rows_read?: number; rows_written?: number } };

function getD1ErrorMessage(error: unknown): string {
	if (!(error instanceof Error))
		return typeof error === "string" ? error : "Unknown D1 error";
	const cause: unknown = Reflect.get(error, "cause");
	const causeMessage = cause instanceof Error ? cause.message : undefined;
	return causeMessage && causeMessage !== error.message
		? `${error.message}\n${causeMessage}`
		: error.message;
}

function wrapD1Database(args: {
	db: globalThis.D1Database;
	dbName: D1Span["db"];
	collector: D1SpanCollector;
}): globalThis.D1Database {
	// Native batch APIs must receive native statements, never our proxies.
	const statements = new WeakMap<
		object,
		{ native: D1PreparedStatement; sqlShape: string }
	>();

	function record(
		sqlShape: string,
		startedAt: number,
		result?: QueryResult,
		error?: unknown
	): void {
		args.collector.push({
			kind: error === undefined ? "d1.query" : "d1.error",
			db: args.dbName,
			ts: startedAt,
			durationMs: Math.max(0, Date.now() - startedAt),
			sqlShape,
			rowsRead: result?.meta?.rows_read,
			rowsWritten: result?.meta?.rows_written,
			errorMessage:
				error === undefined ? undefined : getD1ErrorMessage(error),
		});
	}

	function wrapStatement(
		native: D1PreparedStatement,
		sqlShape: string
	): D1PreparedStatement {
		const proxy = new Proxy(native, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function") return value;
				if (prop === "bind") {
					return (...values: unknown[]) =>
						wrapStatement(
							Reflect.apply(value, target, values),
							sqlShape
						);
				}
				if (!["all", "run", "first", "raw"].includes(String(prop)))
					return value.bind(target);
				return async (...values: unknown[]) => {
					const startedAt = Date.now();
					try {
						const result = await Reflect.apply(
							value,
							target,
							values
						);
						// SAFETY: only native D1 all()/run() results carry query metadata; first()/raw() return user data and are excluded from this assertion.
						record(
							sqlShape,
							startedAt,
							prop === "all" || prop === "run"
								? (result as QueryResult)
								: undefined
						);
						return result;
					} catch (error) {
						record(sqlShape, startedAt, undefined, error);
						throw error;
					}
				};
			},
		});
		statements.set(proxy, { native, sqlShape });
		return proxy;
	}

	return new Proxy(args.db, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) =>
					wrapStatement(target.prepare(sql), normalizeSqlShape(sql));
			}
			if (prop === "batch") {
				return async (batch: D1PreparedStatement[]) => {
					const queries = batch.map(
						(stmt) =>
							statements.get(stmt) ?? {
								native: stmt,
								sqlShape: "batch query",
							}
					);
					const startedAt = Date.now();
					try {
						const results = await target.batch(
							queries.map((query) => query.native)
						);
						queries.forEach((query, index) =>
							record(query.sqlShape, startedAt, results[index])
						);
						return results;
					} catch (error) {
						// A failed batch is one failed operation; do not blame every query.
						record("batch", startedAt, undefined, error);
						throw error;
					}
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export type { D1Span, D1SpanCollector };
export { wrapD1Database };
