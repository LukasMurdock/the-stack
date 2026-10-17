import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
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
			join(directory, "local.env.example"),
			settings + 'BETTER_AUTH_SECRET="replace-me"\n'
		);
		const filename = join(directory, ".env");
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

test("local configuration migrates the legacy secrets file without changing credentials or comments", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-local-env-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const filename = join(directory, ".env");
	const source =
		'# My auth settings\nexport BETTER_AUTH_SECRET="already-configured-local-secret-12345" # keep this\n';
	writeFileSync(join(directory, ".dev.vars"), source);
	const result = spawnSync(process.execPath, [script], {
		cwd: directory,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(filename, "utf8"), source);
	assert.equal(existsSync(join(directory, ".dev.vars")), false);
});

// Wrangler and the Cloudflare Vite plugin read `.env` from the directory of
// the Worker config they are given, so `pnpm dev` only sees local secrets if
// the generated config sits beside `.env`.
test("the generated local Worker config loads secrets from the project's .env", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "stack-local-config-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(
		join(directory, ".env"),
		'RESEND_API_KEY="re_local_only"\nEMAIL_TRANSPORT="resend"\n'
	);
	const generator = fileURLToPath(
		new URL("../../scripts/local-cloudflare.mjs", import.meta.url)
	);
	const result = spawnSync(process.execPath, [generator], {
		cwd: directory,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const { localConfigPath } =
		await import("../../scripts/local-cloudflare.mjs");
	// The same project-relative path, inside the temporary project.
	const configPath = join(
		directory,
		path.relative(process.cwd(), localConfigPath)
	);
	assert.ok(existsSync(configPath));
	const { unstable_getVarsForDev } = await import("wrangler");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const vars = unstable_getVarsForDev(
		configPath,
		undefined,
		config.vars,
		undefined,
		true
	);
	assert.deepEqual(vars.RESEND_API_KEY, {
		type: "secret_text",
		value: "re_local_only",
	});
	// .env overrides the committed local default (EMAIL_TRANSPORT=log).
	assert.deepEqual(vars.EMAIL_TRANSPORT, {
		type: "secret_text",
		value: "resend",
	});
});
