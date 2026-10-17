import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	loadVoidDeployInternals,
	loadVoidProvisioning,
} from "../../scripts/lib/void-cloudflare.ts";
import {
	buildOutputDrift,
	normalizedVoidLock,
	normalizeVoidLock,
	parseVoidLock,
	type VoidLock,
} from "../../scripts/lib/void-lock.ts";

const authored = {
	name: "app",
	main: "./src/worker.ts",
	compatibility_date: "2025-10-08",
	assets: { binding: "ASSETS", directory: "./dist" },
	d1_databases: [
		{
			binding: "CORE_DB",
			database_name: "app-core",
			migrations_dir: "./m",
		},
	],
};

const snapshot =
	"// void:published-traffic:v1:eyJ3b3JrZXJzX2RldiI6dHJ1ZSwicm91dGVzIjpbXX0";

function deployedLock(): VoidLock {
	const resolved = {
		...authored,
		main: "dist/server/entry.mjs",
		no_bundle: false,
		assets: {
			binding: "ASSETS",
			directory: "dist/client",
			run_worker_first: true,
			not_found_handling: "none",
		},
		d1_databases: [{ ...authored.d1_databases[0], database_id: "id-core" }],
	};
	return {
		version: 1,
		source: authored,
		resolved,
		text: `${snapshot}\n${JSON.stringify(resolved, null, 2)}\n`,
	};
}

test("normalizing restores build-output keys and keeps IDs and provenance", () => {
	const lock = deployedLock();
	assert.deepEqual(buildOutputDrift(lock), ["main", "assets", "no_bundle"]);
	const normalized = normalizedVoidLock(lock);
	assert.deepEqual(buildOutputDrift(normalized), []);
	assert.equal(normalized.resolved.main, "./src/worker.ts");
	assert.deepEqual(normalized.resolved.assets, authored.assets);
	assert.ok(!("no_bundle" in normalized.resolved));
	assert.deepEqual(normalized.resolved.d1_databases, [
		{ ...authored.d1_databases[0], database_id: "id-core" },
	]);
	assert.ok(normalized.text.startsWith(`${snapshot}\n{`));
	assert.deepEqual(
		JSON.parse(normalized.text.slice(snapshot.length)),
		normalized.resolved
	);
	// Idempotent, and a field a later Void adds survives.
	const future = { ...lock, extra: { kept: true } };
	assert.deepEqual(normalizedVoidLock(normalizedVoidLock(future)), {
		...normalized,
		extra: { kept: true },
	});
});

test("lock files are parsed at the boundary", () => {
	assert.throws(() => parseVoidLock("{", "void.lock.json"), /not JSON/);
	assert.throws(
		() => parseVoidLock(JSON.stringify({ version: 2 }), "void.lock.json"),
		/not a Void lock file/
	);
});

function temporaryProject(t: test.TestContext): string {
	const root = mkdtempSync(path.join(tmpdir(), "void-lock-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(
		path.join(root, "void.config.ts"),
		`export default { cloudflare: ${JSON.stringify(authored)} };\n`
	);
	mkdirSync(path.join(root, "m"));
	return root;
}

const materialized = (root: string): Record<string, unknown> =>
	JSON.parse(
		readFileSync(path.join(root, ".void-wrangler.jsonc"), "utf8").replace(
			/^\/\/.*\n/gm,
			""
		)
	);

// The regression through Void's own code: provisioning records an ID, the
// framework deploy writes the build output into the generated config, and
// Void persists it as the published-traffic snapshot does.
test("Void's next materialization uses the previous build's output until the lock is normalized", async (t) => {
	const root = temporaryProject(t);
	const provisioning = await loadVoidProvisioning();
	const deploy = await loadVoidDeployInternals();
	const configPath = provisioning.materializeCloudflareConfig(root);
	const provisioned = materialized(root);
	provisioned.d1_databases = [
		{ ...authored.d1_databases[0], database_id: "id-core" },
	];
	writeFileSync(configPath, `${JSON.stringify(provisioned, null, 2)}\n`);
	provisioning.persistCloudflareConfig(root);
	deploy.writeCloudflareFrameworkDeployConfig({
		configPath,
		deployPointerPath: path.join(root, ".wrangler/deploy/config.json"),
		name: "app",
		accountId: undefined,
		main: "dist/server/entry.mjs",
		assetsDirectory: "dist/client",
		compatibilityDate: "2025-10-08",
		crons: [],
	});
	provisioning.persistCloudflareConfig(root);

	provisioning.materializeCloudflareConfig(root);
	assert.equal(materialized(root).main, "dist/server/entry.mjs");

	assert.deepEqual(normalizeVoidLock(root), ["main", "assets", "no_bundle"]);
	assert.deepEqual(normalizeVoidLock(root), []);
	provisioning.materializeCloudflareConfig(root);
	const next = materialized(root);
	assert.equal(next.main, "./src/worker.ts");
	assert.deepEqual(next.assets, authored.assets);
	assert.deepEqual(next.d1_databases, provisioned.d1_databases);
});

test("without a lock there is nothing to normalize", (t) => {
	assert.deepEqual(normalizeVoidLock(temporaryProject(t)), []);
});
