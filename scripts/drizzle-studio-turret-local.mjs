import { spawn } from "node:child_process";
import path from "node:path";

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

const port = process.env.DRIZZLE_STUDIO_PORT ?? "4984";
const host = process.env.DRIZZLE_STUDIO_HOST ?? "127.0.0.1";

const dbPathRaw = process.env.DRIZZLE_DB_PATH;
if (!dbPathRaw) {
	die(
		"Missing DRIZZLE_DB_PATH.\n" +
			"Run: node scripts/find-d1-sqlite.mjs turret_sessions\n" +
			"or use npm run db:turret:studio:local"
	);
}

const dbPath = path.resolve(process.cwd(), dbPathRaw);
const dbUrl = `file:${dbPath}`;

const child = spawn(
	"npx",
	[
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
