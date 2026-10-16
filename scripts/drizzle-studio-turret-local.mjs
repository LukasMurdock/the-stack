import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const port = process.env.DRIZZLE_STUDIO_PORT ?? "4984";
const host = process.env.DRIZZLE_STUDIO_HOST ?? "127.0.0.1";

// find-d1-sqlite prints its own tip (e.g. run local setup) when it fails.
function findDbPath() {
	const result = spawnSync(
		process.execPath,
		["scripts/find-d1-sqlite.mjs", "turret_sessions"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
	);
	if (result.status !== 0) process.exit(result.status ?? 1);
	return result.stdout;
}

const dbPathRaw = process.env.DRIZZLE_DB_PATH || findDbPath();

const dbPath = path.resolve(process.cwd(), dbPathRaw);
const dbUrl = `file:${dbPath}`;

const child = spawn(
	"pnpm",
	[
		"exec",
		"drizzle-kit",
		"studio",
		"--config",
		"src/bindings/d1/turret/drizzle.studio.local.config.ts",
		"--host",
		host,
		"--port",
		port,
	],
	{
		stdio: "inherit",
		env: {
			...process.env,
			DRIZZLE_DB_URL: dbUrl,
		},
	}
);

child.on("exit", (code) => process.exit(code ?? 0));
