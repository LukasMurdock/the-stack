import Database from "better-sqlite3";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DatabaseName = "core" | "turret";
export function migrationDirectory(name: DatabaseName) {
	return new URL(`../../src/bindings/d1/${name}/drizzle/`, import.meta.url);
}

const images = new Map<string, Buffer>();

// Execute unchanged migrations with D1's historical double-quoted-string behavior.
// Reopen the resulting image with the existing SQLite D1 adapter for fast isolated tests.
export function migratedSqlite(...names: DatabaseName[]): Database.Database {
	const key = names.join(",");
	let image = images.get(key);
	if (!image) {
		const directory = mkdtempSync(join(tmpdir(), "stack-migrations-"));
		const file = join(directory, "database.sqlite");
		try {
			const sqlite = new DatabaseSync(file, {
				enableDoubleQuotedStringLiterals: true,
			});
			try {
				for (const name of names) {
					const migrations = migrationDirectory(name);
					for (const filename of readdirSync(migrations)
						.filter((name) => name.endsWith(".sql"))
						.sort())
						sqlite.exec(
							readFileSync(new URL(filename, migrations), "utf8")
						);
				}
			} finally {
				sqlite.close();
			}
			image = readFileSync(file);
			images.set(key, image);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	const sqlite = new Database(image);
	sqlite.pragma("foreign_keys = ON");
	return sqlite;
}
