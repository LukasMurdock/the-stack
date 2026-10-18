// Lists outdated dependencies grouped by how risky the update is, with the
// command that lands each group. Dependabot opens security updates only; this
// report (run weekly in CI, or `pnpm deps:outdated` locally) replaces its
// version-update PRs, so updates land as proved trunk commits instead of PRs
// that go stale against main.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
	type Command,
} from "./lib/cli.ts";

const USAGE = `Usage: pnpm deps:outdated

Prints outdated dependencies as Markdown, grouped as patch and minor updates
(safe to batch), major updates (one at a time) and deprecated packages.`;

// `pnpm outdated --format json` output for one package.
const outdatedSchema = z.record(
	z.string(),
	z.object({
		current: z.string(),
		latest: z.string(),
		isDeprecated: z.boolean(),
		dependencyType: z.string(),
	})
);
type Outdated = z.infer<typeof outdatedSchema>;

export type Bump = "patch" | "minor" | "major";
export type OutdatedPackage = {
	readonly name: string;
	readonly current: string;
	readonly latest: string;
	readonly bump: Bump;
	readonly deprecated: boolean;
	// Why the update is not offered, if it is held back.
	readonly held: string | null;
};

// pnpm's report can be large on a stale project; cap what is read.
const PNPM_OUTPUT_BYTES_MAX = 4 * 1024 * 1024;

export function parseDepsOutdatedOptions(
	argv: readonly string[]
): Command<Record<string, never>> {
	const parsed = parseCommandLine(argv, {
		help: { type: "boolean", short: "h" },
	});
	if (parsed.positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${parsed.positionals[0]}`);
	if (parsed.values.help) return { kind: "help" };
	return { kind: "run", options: {} };
}

function versionParts(version: string): readonly number[] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Semver, with 0.x read the way npm reads it: a 0.y change can break.
// Anything unparseable counts as major, so it is never batched blindly.
export function bumpOf(current: string, latest: string): Bump {
	const from = versionParts(current);
	const to = versionParts(latest);
	if (!from || !to) return "major";
	const [fromMajor, fromMinor] = from;
	const [toMajor, toMinor] = to;
	if (fromMajor !== toMajor) return "major";
	if (fromMajor === 0 && fromMinor !== toMinor) return "major";
	if (fromMinor !== toMinor) return "minor";
	return "patch";
}

// @types/node describes a Node major; it follows the runtime in
// package.json "engines", not npm's latest.
function heldReason(
	name: string,
	latest: string,
	nodeMajor: number | null
): string | null {
	if (name !== "@types/node" || nodeMajor === null) return null;
	const latestMajor = versionParts(latest)?.[0];
	if (latestMajor === undefined || latestMajor <= nodeMajor) return null;
	return `follows the Node ${nodeMajor} runtime (package.json engines)`;
}

export function nodeMajorOf(engines: string | undefined): number | null {
	const match = engines === undefined ? null : /(\d+)/.exec(engines);
	return match ? Number(match[1]) : null;
}

export function parseOutdated(
	json: string,
	nodeMajor: number | null
): readonly OutdatedPackage[] {
	const report: Outdated = outdatedSchema.parse(JSON.parse(json));
	return Object.entries(report)
		.map(([name, entry]) => ({
			name,
			current: entry.current,
			latest: entry.latest,
			bump: bumpOf(entry.current, entry.latest),
			deprecated: entry.isDeprecated,
			held: heldReason(name, entry.latest, nodeMajor),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function table(packages: readonly OutdatedPackage[]): string[] {
	return [
		"| Package | Current | Latest |",
		"| --- | --- | --- |",
		...packages.map((p) => `| ${p.name} | ${p.current} | ${p.latest} |`),
	];
}

export function formatReport(packages: readonly OutdatedPackage[]): string {
	if (packages.length === 0) return "All dependencies are up to date.\n";
	const offered = packages.filter((p) => p.held === null);
	const held = packages.filter((p) => p.held !== null);
	const safe = offered.filter((p) => p.bump !== "major");
	const major = offered.filter((p) => p.bump === "major");
	const deprecated = packages.filter((p) => p.deprecated);
	const lines = [`# Outdated dependencies (${packages.length})`, ""];
	if (safe.length > 0)
		lines.push(
			`## Patch and minor (${safe.length}): one commit`,
			"",
			...table(safe),
			"",
			"```sh",
			`pnpm update --latest ${safe.map((p) => p.name).join(" ")}`,
			'git commit -am "Update dependencies within their major versions"',
			"pnpm proof && pnpm ship",
			"```",
			""
		);
	if (major.length > 0)
		lines.push(
			`## Major (${major.length}): one commit each, after reading the changelog`,
			"",
			...table(major),
			""
		);
	if (held.length > 0)
		lines.push(
			`## Held (${held.length})`,
			"",
			...held.map((p) => `- ${p.name} ${p.latest}: ${p.held ?? ""}`),
			""
		);
	if (deprecated.length > 0)
		lines.push(
			`## Deprecated (${deprecated.length}): replace`,
			"",
			...deprecated.map((p) => `- ${p.name}`),
			""
		);
	return `${lines.join("\n")}\n`;
}

// `pnpm outdated` exits 1 when anything is outdated; only a missing or
// unparseable report is a failure.
function readOutdated(nodeMajor: number | null): readonly OutdatedPackage[] {
	const result = spawnSync("pnpm", ["outdated", "--format", "json"], {
		encoding: "utf8",
		maxBuffer: PNPM_OUTPUT_BYTES_MAX,
	});
	if (result.error)
		throw new CommandError(`Could not run pnpm: ${result.error.message}`);
	if (result.status !== 0 && result.status !== 1)
		throw new CommandError(
			`pnpm outdated exited ${result.status}: ${result.stderr.trim()}`
		);
	const json = result.stdout.trim();
	return json === "" ? [] : parseOutdated(json, nodeMajor);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: USAGE,
		parse: () => parseDepsOutdatedOptions(process.argv.slice(2)),
		run: async () => {
			const manifest = z
				.object({ engines: z.object({ node: z.string() }).optional() })
				.parse(JSON.parse(readFileSync("package.json", "utf8")));
			const nodeMajor = nodeMajorOf(manifest.engines?.node);
			process.stdout.write(formatReport(readOutdated(nodeMajor)));
		},
	});
