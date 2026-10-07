import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

// A removable example: organization-scoped creation and listing.
export const projects = sqliteTable(
	"projects",
	{
		id: text().primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text().notNull(),
		description: text().notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		index("projects_organization_idx").on(
			table.organizationId,
			table.createdAt,
			table.id
		),
	]
);
