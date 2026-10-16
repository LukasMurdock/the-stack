import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import {
	EXAMPLE_PATHS,
	MARKED_FILES,
	markerKind,
	parseExampleRemoveOptions,
	removeMarkedBlocks,
} from "../../scripts/example-remove.ts";
import { UsageError } from "../../scripts/lib/cli.ts";

const root = process.cwd();
const script = path.join(root, "scripts", "example-remove.ts");
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const REMOVAL_TEST_TIMEOUT_MS = 15 * 60_000;
// Generated in place by tools; a copy must not share the real checkout's.
const LOCAL_NODE_MODULES_ENTRIES = new Set([
	".astro",
	".cache",
	".tmp",
	".vite",
]);
// Anything that would still name the example once it is gone.
const EXAMPLE_REFERENCE =
	/features\/projects|project\.create|first-feature|ProjectsPage|example-projects|example:remove|createProject|Create project|organizationId\/projects|projectsRoutes|from "\.\/projects"/;

function run(
	command: string,
	args: readonly string[],
	cwd: string
): SpawnSyncReturns<string> {
	return spawnSync(command, [...args], {
		cwd,
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
	});
}

function repositoryFiles(directory: string): string[] {
	const listed = run(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		directory
	);
	assert.equal(listed.status, 0, listed.stderr);
	return listed.stdout
		.split("\0")
		.filter(
			(file) => file !== "" && existsSync(path.join(directory, file))
		);
}

// The copy has no .git: walk it, skipping generated and linked folders.
const COPY_SKIPPED_DIRECTORIES = new Set([".astro", "node_modules"]);
const COPY_FILES_MAX = 5_000;
function copyFiles(copy: string): string[] {
	const files: string[] = [];
	const pending = [""];
	for (
		let directory = pending.pop();
		directory !== undefined;
		directory = pending.pop()
	) {
		for (const entry of readdirSync(path.join(copy, directory), {
			withFileTypes: true,
		})) {
			const relative = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!COPY_SKIPPED_DIRECTORIES.has(entry.name))
					pending.push(relative);
			} else {
				files.push(relative);
			}
		}
		assert.ok(files.length <= COPY_FILES_MAX, "copy has too many files");
	}
	return files;
}

function textFiles(directory: string, files: readonly string[]) {
	return files
		.filter((file) => !/\.(png|jpe?g|gif|webp|ico|woff2?)$/.test(file))
		.filter((file) => lstatSync(path.join(directory, file)).isFile())
		.map((file) => ({
			file,
			text: readFileSync(path.join(directory, file), "utf8"),
		}));
}

// Tracked and new files plus a node_modules of links to the real packages,
// so tools run in the copy without writing to this checkout.
function copyRepository(t: test.TestContext): string {
	const copy = mkdtempSync(path.join(tmpdir(), "stack-example-remove-"));
	t.after(() => rmSync(copy, { recursive: true, force: true }));
	for (const file of repositoryFiles(root)) {
		const source = path.join(root, file);
		mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
		if (lstatSync(source).isSymbolicLink())
			symlinkSync(readlinkSync(source), path.join(copy, file));
		else copyFileSync(source, path.join(copy, file));
	}
	mkdirSync(path.join(copy, "node_modules"));
	for (const entry of readdirSync(path.join(root, "node_modules"))) {
		if (LOCAL_NODE_MODULES_ENTRIES.has(entry)) continue;
		symlinkSync(
			path.join(root, "node_modules", entry),
			path.join(copy, "node_modules", entry)
		);
	}
	return copy;
}

function assertSucceeded(result: ReturnType<typeof run>, label: string) {
	assert.equal(
		result.status,
		0,
		`${label}\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`
	);
}

test("example:remove options: defaults, flags and malformed input", () => {
	assert.deepEqual(parseExampleRemoveOptions([]), {
		kind: "run",
		options: { dryRun: false, deployed: false },
	});
	assert.deepEqual(parseExampleRemoveOptions(["--dry-run", "--deployed"]), {
		kind: "run",
		options: { dryRun: true, deployed: true },
	});
	assert.deepEqual(parseExampleRemoveOptions(["-h"]), { kind: "help" });
	for (const argv of [["--force"], ["projects"], ["--dry-run=yes"]])
		assert.throws(() => parseExampleRemoveOptions(argv), UsageError);
});

test("marked blocks are removed whole and malformed markers stop the removal", () => {
	assert.equal(markerKind("\t// example:start"), "start");
	assert.equal(markerKind("{/* example:end */}"), "end");
	assert.equal(markerKind("<!-- example:start -->"), "start");
	assert.equal(markerKind("Wrap it in `example:start` comments."), undefined);
	assert.equal(markerKind("// example:started"), undefined);
	const edit = removeMarkedBlocks(
		"file.ts",
		"a\n// example:start\nb\n// example:end\nc\n<!-- example:start -->\nd\n<!-- example:end -->\n"
	);
	assert.deepEqual(edit, {
		file: "file.ts",
		content: "a\nc\n",
		blockCount: 2,
		removedLineCount: 6,
	});
	for (const [content, message] of [
		["// example:start\n// example:start\n", /inside the block/],
		["// example:end\n", /without example:start/],
		["a\n// example:start\nb\n", /never closed/],
	] as const)
		assert.throws(() => removeMarkedBlocks("file.ts", content), message);
});

test("only the manifest's shared files carry example markers", () => {
	const marked = textFiles(root, repositoryFiles(root))
		.filter(({ text }) =>
			text.split("\n").some((line) => markerKind(line) !== undefined)
		)
		.map(({ file }) => file)
		.sort();
	assert.deepEqual(marked, [...MARKED_FILES].sort());
});

test("example:remove --dry-run lists the manifest and changes nothing", () => {
	const result = run(process.execPath, [script, "--dry-run"], root);
	assertSucceeded(result, "dry run");
	for (const file of [...EXAMPLE_PATHS, ...MARKED_FILES]) {
		assert.ok(result.stdout.includes(file), `dry run omits ${file}`);
		assert.ok(existsSync(path.join(root, file)), `dry run removed ${file}`);
	}
	assert.match(
		result.stdout,
		/delete {2}src\/bindings\/d1\/core\/drizzle\/0003_example-projects\.sql/
	);
	assert.match(result.stdout, /Dry run: nothing changed\./);
	const rejected = run(process.execPath, [script, "--keep"], root);
	assert.equal(rejected.status, 2, rejected.stderr);
	assert.match(rejected.stderr, /Unknown option '--keep'/);
	assert.match(rejected.stderr, /Usage:/);
});

test(
	"example:remove leaves a copy that formats and type-checks without the example",
	{ timeout: REMOVAL_TEST_TIMEOUT_MS },
	(t) => {
		const copy = copyRepository(t);
		assertSucceeded(
			run(process.execPath, ["scripts/example-remove.ts"], copy),
			"example:remove"
		);
		// JSON edits drop one entry and keep everything else, key order included.
		const packageText = readFileSync(
			path.join(root, "package.json"),
			"utf8"
		);
		assert.equal(
			readFileSync(path.join(copy, "package.json"), "utf8"),
			packageText.replace(/^\t\t"example:remove": .*\n/m, "")
		);
		const journalPath = "src/bindings/d1/core/drizzle/meta/_journal.json";
		const readJson = (directory: string) =>
			z
				.record(z.string(), z.unknown())
				.parse(
					JSON.parse(
						readFileSync(path.join(directory, journalPath), "utf8")
					)
				);
		const before = readJson(root);
		const entries = z.array(z.unknown()).parse(before.entries);
		assert.equal(
			JSON.stringify(readJson(copy)),
			JSON.stringify({ ...before, entries: entries.slice(0, -1) })
		);
		for (const file of EXAMPLE_PATHS)
			assert.ok(!existsSync(path.join(copy, file)), `${file} remains`);
		const migrations = path.join(copy, "src/bindings/d1/core/drizzle");
		assert.ok(
			!existsSync(path.join(migrations, "0003_example-projects.sql"))
		);
		const leftovers = textFiles(copy, copyFiles(copy)).flatMap(
			({ file, text }) =>
				text
					.split("\n")
					.flatMap((line, index) =>
						EXAMPLE_REFERENCE.test(line) ||
						markerKind(line) !== undefined
							? [`${file}:${index + 1}: ${line.trim()}`]
							: []
					)
		);
		assert.deepEqual(leftovers, []);
		assertSucceeded(
			run("pnpm", ["exec", "oxfmt", "--check", "."], copy),
			"format"
		);
		assertSucceeded(run("pnpm", ["exec", "tsc", "-b"], copy), "tsc -b");
		assertSucceeded(
			run("pnpm", ["exec", "tsc", "-p", "tsconfig.tests.json"], copy),
			"test types"
		);
	}
);

test(
	"example:remove --deployed keeps the migration history and drops the table",
	{ timeout: REMOVAL_TEST_TIMEOUT_MS },
	(t) => {
		const copy = copyRepository(t);
		assertSucceeded(
			run(
				process.execPath,
				["scripts/example-remove.ts", "--deployed"],
				copy
			),
			"example:remove --deployed"
		);
		const migrations = path.join(copy, "src/bindings/d1/core/drizzle");
		assert.ok(
			existsSync(path.join(migrations, "0003_example-projects.sql"))
		);
		const drop = readdirSync(migrations).filter((file) =>
			file.startsWith("0004_")
		);
		assert.deepEqual(drop, ["0004_drop-example-projects.sql"]);
		assert.match(
			readFileSync(path.join(migrations, drop[0]), "utf8"),
			/DROP TABLE `projects`/
		);
	}
);
