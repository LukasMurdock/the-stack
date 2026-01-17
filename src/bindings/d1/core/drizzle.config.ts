import { defineConfig } from "drizzle-kit";

// Core D1 database (local-first): generate migrations via Drizzle Kit,
// apply them via Wrangler D1 migrations.
//
// Intentionally lives under src/bindings/d1/core so we can add other DBs later
// without a single global drizzle config.
export default defineConfig({
	out: "./src/bindings/d1/core/drizzle",
	schema: "./src/bindings/d1/core/schema/index.ts",
	dialect: "sqlite",
});
