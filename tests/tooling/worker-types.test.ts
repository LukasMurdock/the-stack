import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SECRET_NAMES } from "../../src/contracts/secrets.ts";

// scripts/generate-types.mjs passes an empty env file to `wrangler types`.
// Without it Wrangler adds a local .env's variables to Env as required
// strings, and the secrets the code types as optional Store bindings break
// type-checking on any machine that ran `pnpm local:setup`.
test("generated worker types never include secrets from a local .env", () => {
	const types = readFileSync("worker-configuration.d.ts", "utf8");
	assert.match(types, /--env-file=config\/typegen\.env/);
	for (const name of SECRET_NAMES)
		assert.doesNotMatch(
			types,
			new RegExp(`^\\s*${name}: string;`, "m"),
			`${name} leaked into worker-configuration.d.ts`
		);
});

test("the typegen env file stays empty of variables", () => {
	const lines = readFileSync("config/typegen.env", "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	assert.deepEqual(lines, []);
});
