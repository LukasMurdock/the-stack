import { migratedSqlite } from "./migrations";
import { createOrganization } from "../../src/features/organizations/operations";
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

// An organization owned by "owner", with "editor" and "viewer" members.
export async function organizationFixture() {
	const f = productFixture();
	const organization = await createOrganization(f.actor("owner"), {
		name: "Studio",
	});
	for (const role of ["editor", "viewer"])
		f.sqlite
			.prepare("insert into memberships values (?, ?, ?)")
			.run(organization.id, role, role);
	return { ...f, organizationId: organization.id };
}
