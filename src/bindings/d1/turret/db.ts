import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

function makeTurretDb(db: D1Database) {
	return drizzle(db, { schema });
}

type TurretDb = ReturnType<typeof makeTurretDb>;

export { makeTurretDb };
export type { TurretDb };
