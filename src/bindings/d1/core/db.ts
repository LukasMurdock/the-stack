import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

function makeCoreDb(db: D1Database) {
	return drizzle(db, { schema, casing: "snake_case" });
}

type CoreDb = ReturnType<typeof makeCoreDb>;

export { makeCoreDb };
export type { CoreDb };
