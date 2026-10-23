import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import {
	migratedSqlite,
	migrationDirectory,
} from "../../tests/helpers/migrations";
import { migrationProblems, type Rule } from "./migration-guard";

function tableSchema(sqlite: Database.Database, table: string) {
	const indexes = z
		.array(z.object({ name: z.string(), unique: z.number() }))
		.parse(
			sqlite
				.prepare(
					'SELECT name, "unique" FROM pragma_index_list(?) ORDER BY name'
				)
				.all(table)
		);
	return {
		columns: sqlite
			.prepare("SELECT * FROM pragma_table_info(?) ORDER BY cid")
			.all(table),
		foreignKeys: sqlite
			.prepare(
				"SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq"
			)
			.all(table),
		indexes: indexes.map((index) => ({
			...index,
			columns: sqlite
				.prepare("SELECT * FROM pragma_index_info(?) ORDER BY seqno")
				.all(index.name),
		})),
	};
}

// Applied migrations the guard would refuse today. They can't change; each
// says why it stands.
const allowed: Record<string, Rule[]> = {
	// Nothing references the rebuilt Turret tables, so the pragma is only
	// noise. The copy wrote the text "rrweb_start_ts_ms" and
	// "rrweb_last_ts_ms" into sessions that existed then (the columns come
	// from the other 0003, which sorts after it); those sessions are past
	// Turret's retention.
	"turret/0003_gigantic_millenium_guard.sql": [
		"foreign-keys-off",
		"copy-missing-column",
	],
	"turret/0003_sturdy_scorpion.sql": ["foreign-keys-off"],
};
const problems = (["core", "turret"] as const).flatMap((name) => {
	const folder = migrationDirectory(name);
	return migrationProblems(
		readdirSync(folder)
			.filter((file) => file.endsWith(".sql"))
			.sort()
			.map((file) => ({
				name: `${name}/${file}`,
				sql: readFileSync(new URL(file, folder), "utf8"),
			})),
		allowed
	);
});
assert.deepEqual(
	problems,
	[],
	`Migrations D1 would break on:\n${problems.join("\n")}`
);
console.log("Migrations pass the D1 migration guard.");

const directory = mkdtempSync(join(tmpdir(), "stack-d1-migrations-"));
try {
	const config = join(directory, "wrangler.json");
	writeFileSync(
		config,
		JSON.stringify({
			name: "stack-migration-check",
			compatibility_date: "2025-10-08",
			d1_databases: ["core", "turret"].map((name, index) => ({
				binding: name === "core" ? "CORE_DB" : "TURRET_DB",
				database_name: `migration-${name}`,
				database_id: `${index + 1}1111111-1111-4111-8111-111111111111`,
				migrations_dir: fileURLToPath(
					migrationDirectory(name === "core" ? "core" : "turret")
				),
			})),
		})
	);
	for (const binding of ["CORE_DB", "TURRET_DB"])
		execFileSync(
			"pnpm",
			[
				"exec",
				"wrangler",
				"d1",
				"migrations",
				"apply",
				binding,
				"--local",
				"--config",
				config,
				"--persist-to",
				join(directory, "state"),
			],
			{ stdio: "inherit" }
		);
	const filenames = readdirSync(join(directory, "state"), {
		recursive: true,
		encoding: "utf8",
	}).filter((name) => name.endsWith(".sqlite"));
	for (const name of ["core", "turret"] as const) {
		const expected = migratedSqlite(name);
		try {
			const tables = z
				.array(z.object({ name: z.string() }))
				.parse(
					expected
						.prepare(
							"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
						)
						.all()
				);
			let checked = false;
			for (const filename of filenames) {
				const actual = new Database(
					join(directory, "state", filename),
					{ readonly: true }
				);
				try {
					if (
						!actual
							.prepare(
								"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
							)
							.get(tables[0].name)
					)
						continue;
					for (const table of tables)
						assert.deepEqual(
							tableSchema(actual, table.name),
							tableSchema(expected, table.name),
							`${name}.${table.name}: D1 and test fixture differ`
						);
					checked = true;
				} finally {
					actual.close();
				}
			}
			assert.ok(checked, `${name}: migrated D1 database missing`);
		} finally {
			expected.close();
		}
	}
	console.log("D1 migration chains and test fixture schemas agree.");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
