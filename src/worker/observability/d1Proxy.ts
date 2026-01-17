import { normalizeSqlShape } from "./sqlShape";

type D1Database = any;

type Span = {
	kind: "d1.query" | "d1.error";
	db: "CORE_DB" | "TURRET_DB";
	ts: number;
	durationMs: number;
	sqlShape: string;
	rowsRead?: number;
	rowsWritten?: number;
	errorMessage?: string;
};

type D1SpanCollector = {
	push(span: Span): void;
};

function getD1ErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		const parts: string[] = [];
		if (err.message) parts.push(err.message);
		const causeMsg = (err as any)?.cause?.message;
		if (typeof causeMsg === "string" && causeMsg && causeMsg !== err.message) {
			parts.push(causeMsg);
		}
		return parts.join("\n");
	}
	return typeof err === "string" ? err : "Unknown D1 error";
}

function wrapD1Database(args: {
	db: D1Database;
	dbName: "CORE_DB" | "TURRET_DB";
	requestTs: number;
	collector: D1SpanCollector;
}): D1Database {
	const original = args.db as any;

	return new Proxy(args.db as any, {
		get(target, prop, receiver) {
			if (prop !== "prepare") return Reflect.get(target, prop, receiver);

			return (sql: string) => {
				const sqlShape = normalizeSqlShape(sql);
				const stmt = original.prepare(sql);

				return new Proxy(stmt as any, {
					get(stmtTarget, stmtProp, stmtReceiver) {
						const val = Reflect.get(stmtTarget, stmtProp, stmtReceiver);
						if (typeof val !== "function") return val;
						if (
							stmtProp !== "all" &&
							stmtProp !== "run" &&
							stmtProp !== "first" &&
							stmtProp !== "raw"
						) {
							return val;
						}

						return async (...fnArgs: any[]) => {
							const t0 = Date.now();
							try {
								const res = await val.apply(stmtTarget, fnArgs);
								const t1 = Date.now();

								const meta = (res as any)?.meta;
								args.collector.push({
									kind: "d1.query",
									db: args.dbName,
									ts: args.requestTs,
									durationMs: Math.max(0, t1 - t0),
									sqlShape,
									rowsRead: typeof meta?.rows_read === "number" ? meta.rows_read : undefined,
									rowsWritten:
										typeof meta?.rows_written === "number" ? meta.rows_written : undefined,
								});

								return res;
							} catch (err) {
								const t1 = Date.now();
								args.collector.push({
									kind: "d1.error",
									db: args.dbName,
									ts: args.requestTs,
									durationMs: Math.max(0, t1 - t0),
									sqlShape,
									errorMessage: getD1ErrorMessage(err),
								});
								throw err;
							}
						};
					},
				});
			};
		},
	});
}

export type { Span as D1Span, D1SpanCollector };
export { wrapD1Database };
