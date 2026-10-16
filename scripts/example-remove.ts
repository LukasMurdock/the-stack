// Deletes the Projects example in one step, so a fork starts from core
// organizations, auth and Turret with every remaining check green. The
// manifest below is the complete list of what the example owns; the tooling
// test removes it from a copy of the repository and type-checks the result.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";

export const EXAMPLE_REMOVE_USAGE = `Usage: pnpm example:remove [--dry-run] [--deployed]

Deletes the Projects example: its feature folders, route, table, tests and
walkthrough, the marked lines that register it in shared files, and this
command. Then it regenerates the route tree and formats what it edited.

  --dry-run   List what would change and change nothing.
  --deployed  A deployed database already has the projects table. Keep the
              migration history and add a migration that drops the table.
              Without it, the example's migration is deleted, which is only
              valid while no database outside your machine has applied it.`;

// Files and folders the example owns outright, relative to the repository.
export const EXAMPLE_PATHS = [
	"src/features/projects",
	"src/react-app/features/projects",
	"src/react-app/routes/_authenticated/organizations/$organizationId/projects",
	"src/bindings/d1/core/schema/projects.ts",
	"src/content/docs/v1/first-feature.md",
	"tests/integration/projects.test.ts",
	"tests/e2e/projects.spec.ts",
	"tests/tooling/example-remove.test.ts",
	"scripts/example-remove.ts",
] as const;

// Shared files whose example lines sit between start and end marker comments.
export const MARKED_FILES = [
	"src/worker/api/index.ts",
	"src/bindings/d1/core/schema/index.ts",
	"src/contracts/turret-outcomes.ts",
	"src/contracts/feature-flags.ts",
	"src/react-app/routes/_authenticated/organizations/$organizationId.tsx",
	"src/components/docs/DocsNav.tsx",
	"src/pages/docs/index.astro",
	"src/content/docs/v1/welcome.md",
	"src/content/docs/v1/extend.md",
	"scripts/dev-status.mjs",
	"scripts/setup-local.mjs",
	"README.md",
	"CONTRIBUTING.md",
	"AGENTS.md",
] as const;

const MIGRATIONS_DIRECTORY = "src/bindings/d1/core/drizzle";
const MIGRATION_TAG = "0003_example-projects";
const MIGRATION_FILES = [
	`${MIGRATIONS_DIRECTORY}/${MIGRATION_TAG}.sql`,
	`${MIGRATIONS_DIRECTORY}/meta/0003_snapshot.json`,
] as const;
const JOURNAL_PATH = `${MIGRATIONS_DIRECTORY}/meta/_journal.json`;
const PACKAGE_JSON_PATH = "package.json";
const PACKAGE_SCRIPT = "example:remove";
const COMMAND_TIMEOUT_MS = 5 * 60_000;

// A whole line holding only a marker comment, in //, JSX or HTML syntax.
const MARKER_PATTERN =
	/^\s*(?:\/\/ |\{\/\* |<!-- )example:(start|end)(?: \*\/\}| -->)?\s*$/;

export type MarkerKind = "start" | "end";

export function markerKind(line: string): MarkerKind | undefined {
	const match = MARKER_PATTERN.exec(line);
	if (match === null) return undefined;
	return match[1] === "start" ? "start" : "end";
}

export type ExampleRemoveOptions = {
	readonly dryRun: boolean;
	readonly deployed: boolean;
};

export function parseExampleRemoveOptions(
	argv: readonly string[]
): Command<ExampleRemoveOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		"dry-run": { type: "boolean" },
		deployed: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	return {
		kind: "run",
		options: {
			dryRun: values["dry-run"] === true,
			deployed: values.deployed === true,
		},
	};
}

export type MarkedEdit = {
	readonly file: string;
	readonly content: string;
	readonly blockCount: number;
	readonly removedLineCount: number;
};

// Drops every start..end block, markers included. Blocks do not nest.
export function removeMarkedBlocks(file: string, content: string): MarkedEdit {
	const kept: string[] = [];
	let blockCount = 0;
	let removedLineCount = 0;
	let startLine: number | undefined;
	for (const [index, line] of content.split("\n").entries()) {
		const kind = markerKind(line);
		if (kind === "start") {
			if (startLine !== undefined)
				throw new CommandError(
					`${file}:${index + 1}: example:start inside the block opened on line ${startLine}.`
				);
			startLine = index + 1;
		} else if (kind === "end") {
			if (startLine === undefined)
				throw new CommandError(
					`${file}:${index + 1}: example:end without example:start.`
				);
			startLine = undefined;
			blockCount += 1;
			removedLineCount += 1;
			continue;
		}
		if (startLine === undefined) kept.push(line);
		else removedLineCount += 1;
	}
	if (startLine !== undefined)
		throw new CommandError(
			`${file}:${startLine}: example:start is never closed.`
		);
	return { file, content: kept.join("\n"), blockCount, removedLineCount };
}

// JSON files are rewritten from the parsed objects, which keep key order;
// the schemas only check the fields this script reads.
const jsonObjectSchema = z.record(z.string(), z.unknown());
const journalEntrySchema = z.looseObject({ tag: z.string() });
const packageScriptsSchema = z.record(z.string(), z.string());

export type MigrationPlan =
	| { readonly kind: "delete"; readonly journal: string }
	| { readonly kind: "drop" };

export type RemovalPlan = {
	readonly deletions: readonly string[];
	readonly edits: readonly MarkedEdit[];
	readonly migration: MigrationPlan;
	readonly packageJson: string;
};

function requireExists(root: string, file: string): void {
	if (!existsSync(path.join(root, file)))
		throw new CommandError(
			`${file} is missing. The example may already be removed, or the manifest in scripts/example-remove.ts is out of date.`
		);
}

function readText(root: string, file: string): string {
	requireExists(root, file);
	return readFileSync(path.join(root, file), "utf8");
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function readJsonObject(root: string, file: string) {
	return jsonObjectSchema.parse(JSON.parse(readText(root, file)));
}

function planMigration(root: string, deployed: boolean): MigrationPlan {
	const journal = readJsonObject(root, JOURNAL_PATH);
	const entries = z.array(z.unknown()).parse(journal.entries);
	const position = entries.findIndex(
		(entry) => journalEntrySchema.parse(entry).tag === MIGRATION_TAG
	);
	if (position === -1)
		throw new CommandError(
			`${JOURNAL_PATH} has no ${MIGRATION_TAG} entry.`
		);
	if (deployed) return { kind: "drop" };
	if (position !== entries.length - 1)
		throw new CommandError(
			`Core migrations after ${MIGRATION_TAG} exist, so this history has probably been applied somewhere. Rerun with --deployed to keep it and drop the table in a new migration.`
		);
	return {
		kind: "delete",
		journal: jsonText({ ...journal, entries: entries.slice(0, position) }),
	};
}

function planPackageJson(root: string): string {
	const manifest = readJsonObject(root, PACKAGE_JSON_PATH);
	const scripts = packageScriptsSchema.parse(manifest.scripts);
	if (!(PACKAGE_SCRIPT in scripts))
		throw new CommandError(
			`${PACKAGE_JSON_PATH} has no "${PACKAGE_SCRIPT}" script.`
		);
	const kept = Object.fromEntries(
		Object.entries(scripts).filter(([name]) => name !== PACKAGE_SCRIPT)
	);
	return jsonText({ ...manifest, scripts: kept });
}

// Reads everything and validates the whole removal before anything changes.
export function planRemoval(root: string, deployed: boolean): RemovalPlan {
	for (const file of EXAMPLE_PATHS) requireExists(root, file);
	const edits = MARKED_FILES.map((file) =>
		removeMarkedBlocks(file, readText(root, file))
	);
	for (const edit of edits) {
		if (edit.blockCount === 0)
			throw new CommandError(
				`${edit.file} has no example markers; update the manifest in scripts/example-remove.ts.`
			);
	}
	const migration = planMigration(root, deployed);
	const deletions: string[] = [...EXAMPLE_PATHS];
	if (migration.kind === "delete") {
		for (const file of MIGRATION_FILES) requireExists(root, file);
		deletions.push(...MIGRATION_FILES);
	}
	return {
		deletions,
		edits,
		migration,
		packageJson: planPackageJson(root),
	};
}

export function describePlan(plan: RemovalPlan): string[] {
	const lines = plan.deletions.map((file) => `delete  ${file}`);
	for (const edit of plan.edits)
		lines.push(
			`edit    ${edit.file} (blocks: ${edit.blockCount}, lines: ${edit.removedLineCount})`
		);
	if (plan.migration.kind === "delete")
		lines.push(`edit    ${JOURNAL_PATH} (drop ${MIGRATION_TAG})`);
	else lines.push(`add     a core migration that drops the projects table`);
	lines.push(`edit    ${PACKAGE_JSON_PATH} (drop "${PACKAGE_SCRIPT}")`);
	return lines;
}

function run(root: string, args: readonly string[]): void {
	process.stdout.write(`\n$ pnpm ${args.join(" ")}\n`);
	const result = spawnSync("pnpm", [...args], {
		cwd: root,
		stdio: "inherit",
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0)
		throw new CommandError(
			`pnpm ${args.join(" ")} exited with ${String(result.status ?? result.signal)}. The example files are already removed; fix the error and rerun that command.`
		);
}

export function applyRemoval(root: string, plan: RemovalPlan): void {
	for (const file of plan.deletions)
		rmSync(path.join(root, file), { recursive: true, force: true });
	for (const edit of plan.edits)
		writeFileSync(path.join(root, edit.file), edit.content);
	writeFileSync(path.join(root, PACKAGE_JSON_PATH), plan.packageJson);
	const formatted = [
		...plan.edits.map((edit) => edit.file),
		PACKAGE_JSON_PATH,
	];
	if (plan.migration.kind === "delete") {
		writeFileSync(path.join(root, JOURNAL_PATH), plan.migration.journal);
		formatted.push(JOURNAL_PATH);
	}
	// Astro sync runs the TanStack Router generator, rewriting routeTree.gen.ts.
	run(root, ["exec", "astro", "sync"]);
	if (plan.migration.kind === "drop")
		run(root, [
			"exec",
			"drizzle-kit",
			"generate",
			"--config",
			"src/bindings/d1/core/drizzle.config.ts",
			"--name",
			"drop-example-projects",
		]);
	run(root, ["exec", "oxfmt", "--write", ...formatted]);
}

async function removeExample(options: ExampleRemoveOptions): Promise<void> {
	const root = process.cwd();
	const plan = planRemoval(root, options.deployed);
	process.stdout.write(`${describePlan(plan).join("\n")}\n`);
	if (options.dryRun) {
		process.stdout.write("\nDry run: nothing changed.\n");
		return;
	}
	applyRemoval(root, plan);
	process.stdout.write(
		"\nRemoved the Projects example. Run pnpm verify and pnpm test:e2e.\n"
	);
	if (plan.migration.kind === "delete")
		process.stdout.write(
			"Local databases that applied the example keep an unused projects table until pnpm local:reset clears local state.\n"
		);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: EXAMPLE_REMOVE_USAGE,
		parse: () => parseExampleRemoveOptions(process.argv.slice(2)),
		run: removeExample,
	});
