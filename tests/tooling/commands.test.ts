import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

// `just` is not installed by `pnpm install`, so every documented command and
// CI step must be a package.json script; the justfile only aliases them.

const root = process.cwd();
const COMMAND_TIMEOUT_MS = 120_000;

const scripts = new Set(
	Object.keys(
		z
			.object({ scripts: z.record(z.string(), z.string()) })
			.parse(JSON.parse(readFileSync("package.json", "utf8"))).scripts
	)
);
// pnpm's own commands, which docs may use without a script of that name.
const pnpmCommands = new Set(["install", "exec", "dlx", "add", "run"]);

function markdownFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".md"))
		.map((name) => path.join(directory, name));
}

const documented = [
	".github/workflows/ci.yml",
	"justfile",
	"AGENTS.md",
	"README.md",
	"CONTRIBUTING.md",
	...markdownFiles("docs"),
	...markdownFiles("src/content/docs"),
];

function temporaryDirectory(t: test.TestContext, prefix: string) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function runNode(
	args: readonly string[],
	env: Readonly<Record<string, string>> = {}
) {
	return spawnSync(process.execPath, args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: COMMAND_TIMEOUT_MS,
	});
}

test("every `pnpm <name>` in CI, the justfile and docs names a script", () => {
	const missing: string[] = [];
	let commandCount = 0;
	for (const file of documented) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(
			// Commands, not prose: code lines, inline code, CI steps, chains.
			/(?:^\s*|`|run: |&& )pnpm (?:-s )?(?:run )?([a-z][\w:-]*)/gm
		)) {
			const name = match[1];
			if (name === undefined) continue;
			commandCount++;
			if (!scripts.has(name) && !pnpmCommands.has(name))
				missing.push(`${file}: pnpm ${name}`);
		}
	}
	assert.ok(commandCount > 20, `only ${commandCount} commands matched`);
	assert.deepEqual(missing, []);
});

test("CI never needs just, and each just recipe only calls pnpm", () => {
	const ci = readFileSync(".github/workflows/ci.yml", "utf8");
	assert.doesNotMatch(ci, /\bjust\b/);
	const recipeLines = readFileSync("justfile", "utf8")
		.split("\n")
		.filter((line) => line.startsWith("    "))
		.map((line) => line.trim());
	assert.ok(recipeLines.length > 0);
	const other = recipeLines.filter(
		(line) => !line.startsWith("pnpm ") && line !== "@just --list"
	);
	assert.deepEqual(other, []);
});

test("find-d1-sqlite points a fresh checkout at local setup", (t) => {
	const directory = temporaryDirectory(t, "stack-find-d1-");
	const fresh = runNode([
		"scripts/find-d1-sqlite.mjs",
		"core_users",
		path.join(directory, "missing"),
	]);
	assert.equal(fresh.status, 1);
	assert.match(fresh.stderr, /No local D1 state at .*missing/);
	assert.match(fresh.stderr, /pnpm local:setup/);
	// State exists but lacks the table: migrations, not setup, are missing.
	const empty = runNode([
		"scripts/find-d1-sqlite.mjs",
		"core_users",
		directory,
	]);
	assert.equal(empty.status, 1);
	assert.match(empty.stderr, /pnpm db:local:migrate/);
	const usage = runNode(["scripts/find-d1-sqlite.mjs"]);
	assert.equal(usage.status, 1);
	assert.match(usage.stderr, /Usage:/);
});

test("pnpm logs tails the configured app name and forwards arguments", async (t) => {
	const { appName } = await import("../../config/cloudflare.mjs");
	const bin = temporaryDirectory(t, "stack-logs-bin-");
	const fake = path.join(bin, "wrangler");
	writeFileSync(
		fake,
		`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n`
	);
	chmodSync(fake, 0o755);
	const PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
	const forwarded = runNode(["scripts/logs.ts", "--format", "json"], {
		PATH,
	});
	assert.equal(forwarded.status, 3, forwarded.stderr);
	assert.deepEqual(JSON.parse(forwarded.stdout), [
		"tail",
		appName,
		"--format",
		"json",
	]);
	const empty = temporaryDirectory(t, "stack-logs-empty-");
	const missing = runNode(["scripts/logs.ts"], { PATH: empty });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /wrangler was not found.*pnpm logs/);
});

test("pnpm routes regenerates a stale route tree", (t) => {
	const tree = "src/react-app/routeTree.gen.ts";
	const committed = readFileSync(tree, "utf8");
	t.after(() => writeFileSync(tree, committed));
	writeFileSync(tree, "// stale\n");
	const result = spawnSync("pnpm", ["routes"], {
		cwd: root,
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.equal(readFileSync(tree, "utf8"), committed);
});

test("routes:new scaffolds a route and names the regeneration command", (t) => {
	const directory = temporaryDirectory(t, "stack-new-route-");
	mkdirSync(path.join(directory, "src/react-app/routes"), {
		recursive: true,
	});
	const result = spawnSync(
		process.execPath,
		[path.join(root, "scripts/new-route.mjs"), "_public/reports"],
		{ cwd: directory, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS }
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /pnpm routes/);
	assert.match(
		readFileSync(
			path.join(directory, "src/react-app/routes/_public/reports.tsx"),
			"utf8"
		),
		/createFileRoute\("\/_public\/reports"\)/
	);
	const usage = spawnSync(
		process.execPath,
		[path.join(root, "scripts/new-route.mjs")],
		{ cwd: directory, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS }
	);
	assert.equal(usage.status, 1);
	assert.match(usage.stderr, /Usage: pnpm routes:new/);
});
