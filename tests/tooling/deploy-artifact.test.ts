import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
	type Artifact,
	type ArtifactModule,
	cronBundleHint,
	expectedFromConfig,
	parseDeployArtifactOptions,
	relativeImports,
	verifyArtifact,
} from "../../scripts/testing/deploy-artifact.ts";

// `pnpm check:deploy` itself builds the app (the proof's deploy step runs it
// for real); these tests cover what it concludes from an artifact.

const esm = (source: string): ArtifactModule => ({ type: "esm", source });

const config = {
	name: "app",
	compatibility_date: "2025-10-08",
	vars: { APP_ENV: "production", LIMITS: { max: 1 } },
	d1_databases: [{ binding: "CORE_DB", database_name: "core" }],
	kv_namespaces: [{ binding: "CORE_KV" }],
	r2_buckets: [{ binding: "BUCKET" }],
	analytics_engine_datasets: [{ binding: "METRICS", dataset: "m" }],
	flagship: [{ binding: "FLAGS" }],
	assets: { binding: "ASSETS", directory: "./dist" },
	version_metadata: { binding: "CF_VERSION_METADATA" },
	analytics: { binding: "ANALYTICS_SQL" },
	triggers: { crons: ["0 * * * *"] },
};

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		mainModule: "index.js",
		modules: new Map([
			["index.js", esm('import "./a.js";\nexport * from "./sub/b.js";')],
			["a.js", esm('const lazy = () => import("./sub/b.js");')],
			["sub/b.js", esm('import { x } from "../a.js";')],
			["data.wasm", { type: "compiled-wasm", source: null }],
		]),
		bindings: new Map([
			["APP_ENV", "text"],
			["LIMITS", "json"],
			["CORE_DB", "d1"],
			["CORE_KV", "kv"],
			["BUCKET", "r2"],
			["METRICS", "analytics-engine-dataset"],
			["FLAGS", "flagship"],
			["ASSETS", "assets"],
			["CF_VERSION_METADATA", "version-metadata"],
			["ANALYTICS_SQL", "analytics"],
		]),
		schedules: ["0 * * * *"],
		...overrides,
	};
}

test("a complete artifact matching its config has no problems", () => {
	assert.deepEqual(
		verifyArtifact(artifact(), expectedFromConfig(config)),
		[]
	);
});

test("the artifact must contain its main module and every relative import", () => {
	const expected = expectedFromConfig(config);
	assert.match(
		verifyArtifact(artifact({ mainModule: "entry.mjs" }), expected).join(
			"\n"
		),
		/main module entry\.mjs is not in the bundle/
	);
	// The Void 1.1.11 defect: the wrapper imports a chunk it did not copy.
	const modules = new Map(artifact().modules);
	modules.set(
		"__void_handlers.js",
		esm('import { r } from "./react-8wLGEpWo.js";')
	);
	assert.deepEqual(verifyArtifact(artifact({ modules }), expected), [
		"__void_handlers.js imports ./react-8wLGEpWo.js, which is not in the bundle.",
	]);
});

test("relative imports are read from code, not from strings or comments", () => {
	assert.deepEqual(
		relativeImports(
			[
				'import a from "./a.js";',
				'export { b } from "../b.js";',
				'const c = await import("./c.js");',
				'import "node:fs"; import d from "pkg";',
				"// import e from './e.js';",
				"const help = \"lazy(() => import('./MyComponent'))\";",
			].join("\n")
		),
		["./a.js", "../b.js", "./c.js"]
	);
});

test("bindings must match the config by name and type", () => {
	const expected = expectedFromConfig(config);
	const bindings = new Map(
		[...artifact().bindings].filter(([name]) => name !== "CORE_DB")
	);
	bindings.set("CORE_KV", "r2");
	bindings.set("EXTRA", "ai");
	assert.deepEqual(verifyArtifact(artifact({ bindings }), expected), [
		"The Worker is missing the d1 binding CORE_DB.",
		"CORE_KV is a r2 binding; the config declares kv.",
		"The Worker has a ai binding EXTRA the config does not declare.",
	]);
});

test("cron schedules must match the config's triggers", () => {
	const expected = expectedFromConfig(config);
	assert.match(
		verifyArtifact(artifact({ schedules: [] }), expected).join("\n"),
		/runs on \[\]; the config declares triggers\.crons \[0 \* \* \* \*\]/
	);
	assert.deepEqual(
		verifyArtifact(
			artifact({ schedules: [] }),
			expectedFromConfig({ ...config, triggers: { crons: [] } })
		),
		[]
	);
});

test("the config is parsed strictly: unknown binding kinds and duplicates stop the check", () => {
	assert.throws(
		() => expectedFromConfig({ ...config, services: [{ binding: "API" }] }),
		/declares services, which pnpm check:deploy cannot compare yet/
	);
	assert.throws(
		() =>
			expectedFromConfig({
				...config,
				kv_namespaces: [{ binding: "CORE_DB" }],
			}),
		/declares CORE_DB twice/
	);
	assert.throws(
		() => expectedFromConfig({ ...config, kv_namespaces: [{}] }),
		/kv_namespaces has an entry without a binding/
	);
	assert.throws(() => expectedFromConfig({ ...config, name: 1 }), /name/);
});

test("check:deploy options: no arguments, --help, and bad input", () => {
	assert.deepEqual(parseDeployArtifactOptions([]), {
		kind: "run",
		options: {},
	});
	assert.deepEqual(parseDeployArtifactOptions(["-h"]), { kind: "help" });
	assert.throws(() => parseDeployArtifactOptions(["now"]), /Unexpected/);
	assert.throws(() => parseDeployArtifactOptions(["--fast"]), /Unknown/);
});

test("node scripts/testing/deploy-artifact.ts at its boundary: help and usage errors", () => {
	const script = path.join(
		process.cwd(),
		"scripts/testing/deploy-artifact.ts"
	);
	const run = (args: readonly string[]) =>
		spawnSync(process.execPath, [script, ...args], {
			encoding: "utf8",
			timeout: 60_000,
		});
	const help = run(["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Usage: pnpm check:deploy/);
	for (const args of [["--skip-build"], ["extra"]]) {
		const bad = run(args);
		assert.equal(bad.status, 2, bad.stderr);
		assert.match(bad.stderr, /Usage: pnpm check:deploy/);
	}
});

test("a split crons/ bundle is explained, other bundling errors are not", () => {
	// The exact message Void's re-bundle gave when crons/ imported the API Worker.
	const split =
		"[UNRESOLVED_IMPORT] Could not resolve './react-8wLGEpWo.js' in dist/server/__void_handlers.js";
	assert.match(cronBundleHint(split), /src\/worker\/scheduled-cleanup\.ts/);
	assert.equal(
		cronBundleHint(
			"[UNRESOLVED_IMPORT] Could not resolve './x.js' in dist/server/entry.mjs"
		),
		""
	);
});
