import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const coreUsers = sqliteTable("core_users", {
	id: int().primaryKey({ autoIncrement: true }),
	email: text().notNull().unique(),
});

export * from "./better-auth";
