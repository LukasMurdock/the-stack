import { z } from "zod";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
test("Oxlint enforces native TypeScript and React rules plus TanStack and Drizzle plugins", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-lint-test-"));
	t.after(() => rmSync(directory, { force: true, recursive: true }));
	const file = join(directory, "probe.tsx");
	writeFileSync(
		file,
		`
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
`
	);
	const result = spawnSync(
		"pnpm",
		["exec", "oxlint", "-c", ".oxlintrc.json", "--format", "json", file],
		{ encoding: "utf8" }
	);
	assert.equal(result.status, 1, result.stderr);
	const report = z
		.object({ diagnostics: z.array(z.object({ code: z.string() })) })
		.parse(JSON.parse(result.stdout));
	const codes = report.diagnostics.map((entry) => entry.code);
	for (const expected of [
		"typescript(no-explicit-any)",
		"react-hooks(rules-of-hooks)",
		"@tanstack/query(stable-query-client)",
		"@tanstack/query(exhaustive-deps)",
		"@tanstack/router(route-param-names)",
		"drizzle(enforce-delete-with-where)",
		"react-refresh(only-export-components)",
	])
		assert.ok(codes.includes(expected), `Missing rule: ${expected}`);
	assert.equal(
		codes.filter((code) => code === "drizzle(enforce-delete-with-where)")
			.length,
		1
	);
});
