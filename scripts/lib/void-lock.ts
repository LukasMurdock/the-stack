// void.lock.json keeps the authored Cloudflare config (`source`) beside what
// Void last wrote into the generated .void-wrangler.jsonc (`resolved`). While
// `source` is unchanged, Void's next materialization uses `resolved` as is.
// That is how provisioned IDs survive, but Void 1.1.11's framework deploy
// also writes the build's output into the generated config (main:
// dist/server/entry.mjs, assets.directory: dist/client) and records it when it
// saves its published-traffic snapshot, so the next build would take the
// previous build's output as its Worker entry.
//
// normalizeVoidLock restores those build-output keys to their authored values
// and keeps everything else Void recorded: resource IDs, the Flagship app ID
// and the `// void:` provenance lines `void project rollback` reads.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const VOID_LOCK_FILE = "void.lock.json";

// What writeCloudflareFrameworkDeployConfig derives from the build output;
// every deploy writes them again.
export const BUILD_OUTPUT_KEYS = ["main", "assets", "no_bundle"] as const;

// Void's own provenance pattern (cloudflare-config's `provenance`).
const PROVENANCE =
	/^\s*\/\/ void:(?:managed-queues|published-traffic):v1:[A-Za-z0-9_-]+\s*$/gm;

// Loose, so a field a later Void adds survives a rewrite.
const lockSchema = z.looseObject({
	version: z.literal(1),
	source: z.record(z.string(), z.unknown()),
	resolved: z.record(z.string(), z.unknown()),
	text: z.string(),
});
export type VoidLock = z.infer<typeof lockSchema>;

export function parseVoidLock(text: string, file: string): VoidLock {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error: unknown) {
		throw new Error(`${file} is not JSON: ${String(error)}`, {
			cause: error,
		});
	}
	const parsed = lockSchema.safeParse(json);
	if (!parsed.success)
		throw new Error(
			`${file} is not a Void lock file:\n${z.prettifyError(parsed.error)}`
		);
	return parsed.data;
}

// Build-output keys whose recorded value differs from the authored one.
export function buildOutputDrift(lock: VoidLock): readonly string[] {
	return BUILD_OUTPUT_KEYS.filter(
		(key) => !isDeepStrictEqual(lock.resolved[key], lock.source[key])
	);
}

export function normalizedVoidLock(lock: VoidLock): VoidLock {
	const resolved: Record<string, unknown> = { ...lock.resolved };
	for (const key of BUILD_OUTPUT_KEYS) {
		if (key in lock.source) resolved[key] = lock.source[key];
		else delete resolved[key];
	}
	const provenance = (lock.text.match(PROVENANCE) ?? [])
		.map((line) => `${line.trim()}\n`)
		.join("");
	return {
		...lock,
		resolved,
		text: `${provenance}${JSON.stringify(resolved, null, 2)}\n`,
	};
}

export function readVoidLock(root: string): VoidLock | null {
	const file = path.join(root, VOID_LOCK_FILE);
	if (!existsSync(file)) return null;
	return parseVoidLock(readFileSync(file, "utf8"), file);
}

// Rewrites void.lock.json only when a build-output key drifted; returns the
// keys it restored (empty: nothing changed, or there is no lock yet).
export function normalizeVoidLock(root: string): readonly string[] {
	const lock = readVoidLock(root);
	if (lock === null) return [];
	const drift = buildOutputDrift(lock);
	if (drift.length === 0) return [];
	writeFileSync(
		path.join(root, VOID_LOCK_FILE),
		`${JSON.stringify(normalizedVoidLock(lock), null, 2)}\n`
	);
	return drift;
}
