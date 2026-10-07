import type { z } from "zod";
import { auth_user } from "./better-auth";
import { sql } from "drizzle-orm";
import {
	sqliteTable,
	text,
	integer,
	primaryKey,
	index,
	check,
} from "drizzle-orm/sqlite-core";
import {
	memberRoleSchema,
	assignableRoleSchema,
} from "../../../../features/organizations/policy";

// Role values are source-controlled enum literals, quoted for SQL CHECK constraints.
function roleValues(roles: readonly string[]) {
	return sql.raw(
		roles.map((role) => `'${role.replace(/'/g, "''")}'`).join(", ")
	);
}

export const organizations = sqliteTable("organizations", {
	id: text().primaryKey(),
	name: text().notNull(),
	createdBy: text("created_by")
		.notNull()
		.references(() => auth_user.id),
	createdAt: integer("created_at").notNull(),
});
export const memberships = sqliteTable(
	"memberships",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => auth_user.id, { onDelete: "cascade" }),
		role: text({
			// SAFETY: this enum is explicitly declared with nonempty values in organization policy.
			enum: memberRoleSchema.options as [
				z.infer<typeof memberRoleSchema>,
				...z.infer<typeof memberRoleSchema>[],
			],
		}).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.userId] }),
		index("memberships_user_idx").on(t.userId),
		check(
			"memberships_role",
			sql`${t.role} in (${roleValues(memberRoleSchema.options)})`
		),
	]
);
export const invitations = sqliteTable(
	"invitations",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text().notNull(),
		role: text({
			// SAFETY: excluding owner leaves the explicitly declared editor and viewer values.
			enum: assignableRoleSchema.options as [
				z.infer<typeof assignableRoleSchema>,
				...z.infer<typeof assignableRoleSchema>[],
			],
		}).notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: integer("expires_at").notNull(),
		acceptedBy: text("accepted_by").references(() => auth_user.id),
		acceptedAt: integer("accepted_at"),
		revokedAt: integer("revoked_at"),
		acceptanceKey: text("acceptance_key"),
	},
	(t) => [
		index("invitations_organization_idx").on(t.organizationId),
		check(
			"invitations_role",
			sql`${t.role} in (${roleValues(assignableRoleSchema.options)})`
		),
	]
);
