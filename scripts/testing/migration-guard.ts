import { DatabaseSync } from "node:sqlite";

// Catches migrations that pass on an empty database but break D1 with real
// data, which is how drizzle-kit's SQLite table rebuilds fail: to add a
// CHECK it recreates the table, copies the rows and drops the old one.
// Replays a chain in
// order and checks each step against the schema it runs on:
//
// - `PRAGMA foreign_keys=OFF` does nothing on D1: foreign keys are always on.
// - Dropping a table other tables reference fails on D1 once those rows
//   exist, or deletes them where they cascade. Rebuilds do this.
// - A rebuild's copy that selects a column the old table doesn't have. When
//   the name is double-quoted, SQLite (and D1) read it as a string instead
//   of failing, so every row silently gets the column's name as its value.
//
// A new migration that must do one of these on purpose says so on its own
// line: `-- migration-guard: allow <rule> (<why>)`. Applied migrations can't
// change, so their exceptions are passed in `allow`, by migration name.

export type Migration = { name: string; sql: string };
export type Rule =
	| "foreign-keys-off"
	| "drop-referenced"
	| "copy-missing-column";

const name = (quoted: string) => quoted.replace(/^[`"[]|[`"\]]$/g, "");

export function migrationProblems(
	migrations: Migration[],
	allow: Record<string, Rule[]> = {}
): string[] {
	const db = new DatabaseSync(":memory:", {
		enableDoubleQuotedStringLiterals: true,
	});
	db.exec("PRAGMA foreign_keys = ON");
	const problems: string[] = [];
	try {
		for (const migration of migrations) {
			const allowed = (rule: Rule) =>
				allow[migration.name]?.includes(rule) ||
				new RegExp(
					`^--\\s*migration-guard:\\s*allow\\s+${rule}\\b`,
					"m"
				).test(migration.sql);
			const flag = (rule: Rule, problem: string) => {
				if (!allowed(rule))
					problems.push(`${migration.name}: ${problem}`);
			};
			if (
				/PRAGMA\s+foreign_keys\s*=\s*(OFF|0|false)/i.test(migration.sql)
			)
				flag(
					"foreign-keys-off",
					"PRAGMA foreign_keys=OFF does nothing on D1 (foreign keys are always on). Add columns in place with ALTER TABLE … ADD, or use PRAGMA defer_foreign_keys = on."
				);
			for (const step of migration.sql.split(
				"--> statement-breakpoint"
			)) {
				for (const [, quoted] of step.matchAll(
					/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"[]?\w+[`"\]]?)/gi
				)) {
					const table = name(quoted!);
					const referencing = referencedBy(db, table);
					if (referencing.length)
						flag(
							"drop-referenced",
							`drops ${table}, which ${referencing.join(", ")} reference${referencing.length === 1 ? "s" : ""}: on D1 the drop fails once those rows exist, or deletes them where they cascade. Add columns in place with ALTER TABLE … ADD instead of rebuilding the table.`
						);
				}
				for (const [, , selected, quoted] of step.matchAll(
					/INSERT\s+INTO\s+[`"]?__new_\w+[`"]?\s*\(([^)]*)\)\s*SELECT\s+([\s\S]+?)\s+FROM\s+([`"[]?\w+[`"\]]?)/gi
				)) {
					const source = name(quoted!);
					const have = new Set(columns(db, source));
					// Literals (NULL, 'text', numbers) and expressions aren't columns.
					const missing = selected!
						.split(",")
						.map((column) => column.trim())
						.filter((column) =>
							/^([`"[]\w+[`"\]]|[A-Za-z_]\w*)$/.test(column)
						)
						.filter((column) => column.toUpperCase() !== "NULL")
						.map(name)
						.filter((column) => !have.has(column));
					if (missing.length)
						flag(
							"copy-missing-column",
							`copies ${missing.join(", ")} from ${source}, which doesn't have ${missing.length === 1 ? "it" : "them"} yet (drizzle-kit's rebuild): double-quoted, SQLite copies the name itself as text into every row. Copy only the old table's columns, or add the column in place.`
						);
				}
				try {
					db.exec(step);
				} catch (error) {
					problems.push(
						`${migration.name}: fails on SQLite: ${error instanceof Error ? error.message : String(error)}`
					);
					return problems;
				}
			}
		}
		return problems;
	} finally {
		db.close();
	}
}

function columns(db: DatabaseSync, table: string) {
	return db
		.prepare("SELECT name FROM pragma_table_info(?)")
		.all(table)
		.map((row) => String(row.name));
}

// Other tables with a foreign key to `table`.
function referencedBy(db: DatabaseSync, table: string) {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
		)
		.all()
		.map((row) => String(row.name));
	return tables.filter(
		(other) =>
			other !== table &&
			db
				.prepare(
					'SELECT 1 FROM pragma_foreign_key_list(?) WHERE "table" = ?'
				)
				.get(other, table) !== undefined
	);
}
