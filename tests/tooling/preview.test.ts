import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { e2ePaths } from "../../scripts/testing/e2e.ts";

const PREVIEW_SCRIPT = path.resolve("scripts/preview.mjs");
const PREVIEW_TIMEOUT_MS = 60_000;

// A fake `pnpm exec astro preview` that does what Void 1.1 does when Astro
// loads its config (copy .void/preview-deploy-config.json over Astro's deploy
// pointer), then records the pointer Astro would read.
const FAKE_PNPM = `#!${process.execPath}
const { copyFileSync, readFileSync, writeFileSync } = require("node:fs");
copyFileSync(".void/preview-deploy-config.json", ".wrangler/deploy/config.json");
writeFileSync("served.json", readFileSync(".wrangler/deploy/config.json"));
`;

function checkout(t: test.TestContext) {
	const root = mkdtempSync(path.join(tmpdir(), "stack-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	writeFileSync(path.join(bin, "pnpm"), FAKE_PNPM);
	chmodSync(path.join(bin, "pnpm"), 0o755);
	mkdirSync(path.join(root, ".void"));
	// The checkout's last build, e.g. `pnpm build` for deployment.
	writeFileSync(
		path.join(root, ".void", "preview-deploy-config.json"),
		'{"configPath":"../../dist/server/wrangler.json"}'
	);
	const run = (env: Record<string, string>) =>
		spawnSync(process.execPath, [PREVIEW_SCRIPT, "--port", "1"], {
			cwd: root,
			encoding: "utf8",
			timeout: PREVIEW_TIMEOUT_MS,
			env: {
				...process.env,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				...env,
			},
		});
	const served = () => readFileSync(path.join(root, "served.json"), "utf8");
	return { root, run, served };
}

test("a browser-test preview serves its port's build, not the checkout's last build", (t) => {
	const { root, run, served } = checkout(t);
	const port = 4399;
	const own = '{"configPath":"../e2e/4399/dist/server/wrangler.json"}';
	const { deployConfig } = e2ePaths(port, root);
	mkdirSync(path.dirname(deployConfig), { recursive: true });
	writeFileSync(deployConfig, own);
	const result = run({ STACK_E2E: "1", STACK_E2E_PORT: String(port) });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(served(), own);
});

test("pnpm preview serves the checkout's last build", (t) => {
	const { run, served } = checkout(t);
	const result = run({ STACK_E2E: "" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(served(), '{"configPath":"../../dist/server/wrangler.json"}');
});
