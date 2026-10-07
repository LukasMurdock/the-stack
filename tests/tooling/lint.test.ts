import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { z } from "zod";

test("configured lint rules reject each unsafe probe in one CLI invocation", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-lint-invalid-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const antiSlopCodes = [
		"no-chained-type-assertions",
		"no-widen-then-assert",
		"no-object-parameters",
		"no-unknown-type-aliases",
		"no-module-mocking",
		"no-reduce-accumulator-copy",
		"require-safety-comment-for-type-assertion",
	].map((rule) => `anti-slop(${rule})`);
	const probes = [
		{
			name: "invalid.ts",
			source: `
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
`,
			expected: [...antiSlopCodes, "oxc(no-accumulating-spread)"],
		},
		{
			name: "invalid.js",
			source: `
import { vi } from 'vitest';
vi.mock('./module');
const values = [1, 2];
export const copied = values.reduce((acc, item) => acc.concat([item]), []);
export const spread = values.reduce((acc, item) => [...acc, item], []);
`,
			expected: [
				"anti-slop(no-module-mocking)",
				"anti-slop(no-reduce-accumulator-copy)",
				"oxc(no-accumulating-spread)",
			],
		},
		{
			name: "framework.tsx",
			source: `
import { QueryClient, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
const db = { delete: (_table: unknown) => ({}) };
const users = {};
export const value: any = 1;
export const Route = createFileRoute('/$invalid-param')({});
export function Component({ id }: { id: string }) {
  const client = new QueryClient();
  if (id) useState(0);
  const query = useQuery({ queryKey: ['item'], queryFn: () => Promise.resolve(id) });
  db.delete(users);
  // oxlint-disable-next-line drizzle/enforce-delete-with-where -- Exercise inline suppression.
  db.delete(users);
  return <div>{query.data}{String(client)}</div>;
}
`,
			expected: [
				"typescript(no-explicit-any)",
				"react-hooks(rules-of-hooks)",
				"@tanstack/query(stable-query-client)",
				"@tanstack/query(exhaustive-deps)",
				"@tanstack/router(route-param-names)",
				"drizzle(enforce-delete-with-where)",
				"react-refresh(only-export-components)",
			],
		},
	];
	for (const probe of probes)
		writeFileSync(join(directory, probe.name), probe.source);
	const result = spawnSync(
		"pnpm",
		[
			"exec",
			"oxlint",
			"-c",
			".oxlintrc.json",
			"--format",
			"json",
			...probes.map((probe) => join(directory, probe.name)),
		],
		{ encoding: "utf8", timeout: 60_000 }
	);
	assert.equal(result.status, 1, result.stderr);
	const diagnostics = z
		.object({
			diagnostics: z.array(
				z.object({
					filename: z.string(),
					code: z.string(),
					severity: z.string(),
				})
			),
		})
		.parse(JSON.parse(result.stdout)).diagnostics;
	for (const probe of probes) {
		const codes = diagnostics
			.filter(
				(diagnostic) =>
					resolve(diagnostic.filename) ===
						join(directory, probe.name) &&
					(probe.name === "framework.tsx" ||
						diagnostic.severity === "error")
			)
			.map((diagnostic) => diagnostic.code);
		for (const code of probe.expected)
			assert.ok(codes.includes(code), `${probe.name}: missing ${code}`);
		if (probe.name === "framework.tsx")
			assert.equal(
				codes.filter(
					(code) => code === "drizzle(enforce-delete-with-where)"
				).length,
				1
			);
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
		{ encoding: "utf8", timeout: 60_000 }
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
