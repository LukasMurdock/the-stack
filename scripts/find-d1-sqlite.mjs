import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function containsTable(dbPath, tableName) {
	try {
		const db = new Database(dbPath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			return Boolean(
				db
					.prepare(
						"select 1 from sqlite_master where type='table' and name=? limit 1"
					)
					.get(tableName)
			);
		} finally {
			db.close();
		}
	} catch {
		return false;
	}
}

const needle = process.argv[2];
if (!needle) {
	die(
		"Usage: node scripts/find-d1-sqlite.mjs <table_name> [persist_dir]\n" +
			"Example: node scripts/find-d1-sqlite.mjs core_users"
	);
}

const persistDir =
	process.argv[3] ?? ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
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
	if (containsTable(file, needle)) {
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
		if (!containsTable(file, otherNeedle)) {
			process.stdout.write(file);
			process.exit(0);
		}
	}

	// Fall back to the newest file.
	matches.sort((a, b) => {
		return statSync(b).mtimeMs - statSync(a).mtimeMs;
	});

	process.stdout.write(matches[0]);
	process.exit(0);
}

die(
	`Could not find a local D1 sqlite file containing table '${needle}'.\n` +
		`Looked in: ${absPersistDir}\n` +
		"Tip: run your local migrations first (just migrate-core / just migrate-turret)."
);
