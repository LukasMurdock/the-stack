import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

const reportSchema = z.object({
	diagnostics: z.array(z.object({ code: z.string(), severity: z.string() })),
});

test("selected anti-slop rules reject unsafe patterns in TypeScript and JavaScript", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-anti-slop-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const ts = join(directory, "invalid.ts");
	writeFileSync(
		ts,
		`
import { vi } from 'vitest';
declare const input: unknown;
export const chained = input as unknown as { id: string };
const widened: unknown = { id: 'known' };
export const narrowed = widened as { id: string };
export function opaque(value: object) { return value; }
export type Payload = unknown;
vi.mock('./module');
const values = [1, 2];
export const copied = values.reduce((acc: number[], item) => acc.concat([item]), []);
export const spread = values.reduce((acc: number[], item) => [...acc, item], []);
`
	);
	const js = join(directory, "invalid.js");
	writeFileSync(
		js,
		`
import { vi } from 'vitest';
vi.mock('./module');
const values = [1, 2];
export const copied = values.reduce((acc, item) => acc.concat([item]), []);
export const spread = values.reduce((acc, item) => [...acc, item], []);
`
	);
	const expected = [
		"no-chained-type-assertions",
		"no-widen-then-assert",
		"no-object-parameters",
		"no-unknown-type-aliases",
		"no-module-mocking",
		"no-reduce-accumulator-copy",
		"require-safety-comment-for-type-assertion",
	].map((rule) => `anti-slop(${rule})`);
	for (const [file, codes] of [
		[ts, [...expected, "oxc(no-accumulating-spread)"]],
		[
			js,
			[
				"anti-slop(no-module-mocking)",
				"anti-slop(no-reduce-accumulator-copy)",
				"oxc(no-accumulating-spread)",
			],
		],
	] as const) {
		const result = spawnSync(
			"pnpm",
			[
				"exec",
				"oxlint",
				"-c",
				".oxlintrc.json",
				"--format",
				"json",
				file,
			],
			{ encoding: "utf8" }
		);
		assert.equal(result.status, 1, result.stderr);
		const errors = reportSchema
			.parse(JSON.parse(result.stdout))
			.diagnostics.filter((entry) => entry.severity === "error")
			.map((entry) => entry.code);
		for (const code of codes)
			assert.ok(errors.includes(code), `Missing ${code} in ${file}`);
	}
});

test("precise types, local accumulator mutation, and justified assertions remain valid", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-anti-slop-valid-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const file = join(directory, "valid.ts");
	writeFileSync(
		file,
		`
export function readString(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Expected string');
  // SAFETY: the preceding typeof check established that the input is a string.
  return input as string;
}
export const values = [1, 2].reduce((acc: number[], item) => { acc.push(item); return acc; }, []);
export const user = { id: 'known' } satisfies { id: string };
`
	);
	const result = spawnSync(
		"pnpm",
		["exec", "oxlint", "-c", ".oxlintrc.json", "--format", "json", file],
		{ encoding: "utf8" }
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Oxlint and its plugin API upgrade together at exact matching versions", () => {
	const manifest = z
		.object({
			devDependencies: z.object({
				oxlint: z.string(),
				"@oxlint/plugins": z.string(),
			}),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL("../../package.json", import.meta.url),
					"utf8"
				)
			)
		);
	assert.match(manifest.devDependencies.oxlint, /^\d+\.\d+\.\d+$/);
	assert.equal(
		manifest.devDependencies.oxlint,
		manifest.devDependencies["@oxlint/plugins"]
	);
});
