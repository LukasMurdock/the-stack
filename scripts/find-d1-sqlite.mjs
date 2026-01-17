import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function sqliteQuery(dbPath, sql) {
	try {
		const out = execFileSync("sqlite3", [dbPath, sql], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.trim();
	} catch (err) {
		return "";
	}
}

const needle = process.argv[2];
if (!needle) {
	die(
		"Usage: node scripts/find-d1-sqlite.mjs <table_name> [persist_dir]\n" +
			"Example: node scripts/find-d1-sqlite.mjs core_users"
	);
}

const persistDir = process.argv[3] ?? ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const absPersistDir = path.resolve(process.cwd(), persistDir);

let entries;
try {
	entries = readdirSync(absPersistDir);
} catch {
	die(`Could not read persistence dir: ${absPersistDir}`);
}

const sqliteFiles = entries
	.filter((f) => f.endsWith(".sqlite"))
	.map((f) => path.join(absPersistDir, f));

const matches = [];

for (const file of sqliteFiles) {
	const hit = sqliteQuery(
		file,
		`select 1 from sqlite_master where type='table' and name='${needle}' limit 1;`
	);
	if (hit === "1") {
		matches.push(file);
	}
}

if (matches.length === 1) {
	process.stdout.write(matches[0]);
	process.exit(0);
}

if (matches.length > 1) {
	// Prefer the sqlite file that does NOT contain tables from the other DB.
	// This avoids picking a shared/old persistence file when both DBs once
	// had the same local database_id.
	const prefersCore = needle === "core_users" || needle.startsWith("auth_");
	const otherNeedle = prefersCore ? "turret_sessions" : "core_users";

	for (const file of matches) {
		const otherHit = sqliteQuery(
			file,
			`select 1 from sqlite_master where type='table' and name='${otherNeedle}' limit 1;`
		);
		if (otherHit !== "1") {
			process.stdout.write(file);
			process.exit(0);
		}
	}

	// Fall back to the newest file.
	matches.sort((a, b) => {
		const aTime = execFileSync("stat", ["-f", "%m", a], { encoding: "utf8" }).trim();
		const bTime = execFileSync("stat", ["-f", "%m", b], { encoding: "utf8" }).trim();
		return Number(bTime) - Number(aTime);
	});

	process.stdout.write(matches[0]);
	process.exit(0);
}

die(
	`Could not find a local D1 sqlite file containing table '${needle}'.\n` +
		`Looked in: ${absPersistDir}\n` +
		`Tip: run your local migrations first (npm run db:core:migrate:local / db:turret:migrate:local).`
);
