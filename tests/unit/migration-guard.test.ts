import assert from "node:assert/strict";
import test from "node:test";
import { migrationProblems } from "../../scripts/testing/migration-guard";

const parent = {
	name: "0000_tables.sql",
	sql: "CREATE TABLE `shops` (`id` text PRIMARY KEY, `state` text);--> statement-breakpoint\nCREATE TABLE `orders` (`id` text PRIMARY KEY, `shop_id` text REFERENCES `shops`(`id`));",
};
// drizzle-kit 0.31's rebuild for a new enum column on a referenced table,
// copying the new column from the old table.
const rebuild = {
	name: "0001_rebuild.sql",
	sql: `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_shops\` (\`id\` text PRIMARY KEY, \`state\` text, \`hold\` text CHECK("hold" in ('a', 'b')));--> statement-breakpoint
INSERT INTO \`__new_shops\`("id", "state", "hold") SELECT "id", "state", "hold" FROM \`shops\`;--> statement-breakpoint
DROP TABLE \`shops\`;--> statement-breakpoint
ALTER TABLE \`__new_shops\` RENAME TO \`shops\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`,
};

test("the migration guard refuses each way a rebuild breaks D1", () => {
	const problems = migrationProblems([parent, rebuild]);
	assert.equal(problems.length, 3);
	assert.match(
		problems[0],
		/^0001_rebuild\.sql: PRAGMA foreign_keys=OFF does nothing on D1/
	);
	assert.match(
		problems[1],
		/copies hold from shops, which doesn't have it yet/
	);
	assert.match(problems[2], /drops shops, which orders references/);
});

test("the guard passes in-place changes, literals, unreferenced rebuilds and stated exceptions", () => {
	assert.deepEqual(
		migrationProblems([
			parent,
			{
				name: "0001_in_place.sql",
				sql: "ALTER TABLE `shops` ADD `hold` text CHECK(`hold` in ('a', 'b'));",
			},
			{
				// Rebuilding a table nothing references, copying a literal.
				name: "0002_orders.sql",
				sql: `CREATE TABLE \`__new_orders\` (\`id\` text PRIMARY KEY, \`shop_id\` text, \`note\` text);--> statement-breakpoint
INSERT INTO \`__new_orders\`("id", "shop_id", "note") SELECT "id", "shop_id", NULL FROM \`orders\`;--> statement-breakpoint
DROP TABLE \`orders\`;--> statement-breakpoint
ALTER TABLE \`__new_orders\` RENAME TO \`orders\`;`,
			},
		]),
		[]
	);
	// A drop made safe on purpose (rows set aside first) says so.
	const stated = {
		name: "0001_rebuild.sql",
		sql: `-- migration-guard: allow drop-referenced (orders set aside and restored)\n-- migration-guard: allow foreign-keys-off (left from drizzle-kit)\n-- migration-guard: allow copy-missing-column (test)\n${rebuild.sql}`,
	};
	assert.deepEqual(migrationProblems([parent, stated]), []);
	assert.deepEqual(
		migrationProblems([parent, rebuild], {
			"0001_rebuild.sql": [
				"drop-referenced",
				"foreign-keys-off",
				"copy-missing-column",
			],
		}),
		[]
	);
});

test("a migration that fails on SQLite is reported and stops the replay", () => {
	const problems = migrationProblems([
		parent,
		{ name: "0001_bad.sql", sql: "ALTER TABLE `missing` ADD `x` text;" },
		{ name: "0002_after.sql", sql: "SELECT 1;" },
	]);
	assert.deepEqual(problems.length, 1);
	assert.match(problems[0], /^0001_bad\.sql: fails on SQLite: .*missing/);
});
