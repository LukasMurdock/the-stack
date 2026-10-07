import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const script = fileURLToPath(
	new URL("../../scripts/setup-local-env.mjs", import.meta.url)
);

test("local configuration initializes missing secrets without rotating them or changing other settings", (t) => {
	for (const initial of [
		undefined,
		"",
		'BETTER_AUTH_SECRET="replace-me"\n',
		'BETTER_AUTH_SECRET=""\n',
		'BETTER_AUTH_SECRET="\n"\n',
		"export BETTER_AUTH_SECRET = replace-me # keep inline comment\n",
		'BETTER_AUTH_SECRET="shadowed-value"\nBETTER_AUTH_SECRET="replace-me"\n',
	]) {
		const directory = mkdtempSync(join(tmpdir(), "stack-local-env-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const settings =
			'# Keep my settings\nADMIN_EMAIL="builder@example.test"\n';
		writeFileSync(
			join(directory, ".dev.vars.example"),
			settings + 'BETTER_AUTH_SECRET="replace-me"\n'
		);
		const filename = join(directory, ".dev.vars");
		if (initial !== undefined) writeFileSync(filename, settings + initial);
		function initialize() {
			const result = spawnSync(process.execPath, [script], {
				cwd: directory,
				env: {
					...process.env,
					BETTER_AUTH_SECRET: "shell-must-not-hide-placeholder",
				},
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		}
		const output = initialize();
		const saved = readFileSync(filename, "utf8");
		assert.ok(saved.startsWith(settings));
		if (initial?.includes("# keep inline comment"))
			assert.ok(saved.includes("# keep inline comment"));
		const secret = dotenv.parse(saved).BETTER_AUTH_SECRET;
		assert.ok(secret.length >= 32);
		assert.notEqual(secret, "shell-must-not-hide-placeholder");
		assert.ok(!output.includes(secret));
		initialize();
		assert.equal(readFileSync(filename, "utf8"), saved);
	}
});

test("local configuration preserves an existing secret and comments byte for byte", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-local-env-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const filename = join(directory, ".dev.vars");
	const source =
		'# My auth settings\nexport BETTER_AUTH_SECRET="already-configured-local-secret-12345" # keep this\n';
	writeFileSync(filename, source);
	const result = spawnSync(process.execPath, [script], {
		cwd: directory,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(filename, "utf8"), source);
});
