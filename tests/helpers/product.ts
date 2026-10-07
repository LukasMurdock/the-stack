import { migratedSqlite } from "./migrations";
import { makeCoreDb } from "../../src/bindings/d1/core/db";
import { createSqliteD1 } from "./sqlite-d1";
import type { OperationContext } from "../../src/features/shared/context";

export function productFixture(sqlite = migratedSqlite("core")) {
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
