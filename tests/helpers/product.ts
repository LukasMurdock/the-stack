import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { makeCoreDb } from "../../src/bindings/d1/core/db";
import { createSqliteD1 } from "./sqlite-d1";
import type { OperationContext } from "../../src/features/shared/context";

export function productFixture() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	const directory = new URL(
		"../../src/bindings/d1/core/drizzle/",
		import.meta.url
	);
	for (const name of readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort())
		sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
	for (const id of ["owner", "editor", "viewer", "outsider"])
		sqlite
			.prepare(
				"insert into auth_user (id, name, email, email_verified) values (?, ?, ?, 1)"
			)
			.run(id, id, `${id}@example.test`);
	const binding = createSqliteD1(sqlite);
	const db = makeCoreDb(binding);
	function actor(userId: string): OperationContext {
		return {
			db,
			actor: {
				userId,
			},
		};
	}
	return { sqlite, binding, db, actor };
}
