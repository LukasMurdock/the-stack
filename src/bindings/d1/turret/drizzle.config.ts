import { defineConfig } from "drizzle-kit";

// Turret D1 database: session replays + error events + indices.
export default defineConfig({
	out: "./src/bindings/d1/turret/drizzle",
	schema: "./src/bindings/d1/turret/schema/index.ts",
	dialect: "sqlite",
});
