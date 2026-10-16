import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deploymentCloudflare } from "../../config/cloudflare.mjs";
import {
	provisionFlagship,
	provisionResources,
	provisioningPlans,
	readCloudflareConfig,
} from "../../scripts/provision-resources.mjs";
import type { WranglerResult } from "../../scripts/lib/flagship.ts";

// Exercise the installed Void provisioning engine; fake only its remote
// transport so creation, lock persistence, and retries need no cloud account.
test("Void provisions separate Core/Turret resources and reuses their lock on retry", async (t) => {
	const declared = provisioningPlans(deploymentCloudflare);
	assert.deepEqual(
		declared.map((plan: { d1: { binding: string } }) => plan.d1.binding),
		["CORE_DB", "TURRET_DB"]
	);
	for (const database of deploymentCloudflare.d1_databases)
		assert.equal("database_id" in database, false);
	assert.notEqual(declared[0]?.r2?.bucketName, "default");
	const root = mkdtempSync(path.join(tmpdir(), "stack-provision-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = {
		name: "fixture-stack",
		account_id: "f".repeat(32),
		d1_databases: ["core", "turret"].map((name) => ({
			binding: `${name.toUpperCase()}_DB`,
			database_name: `fixture-stack-${name}`,
			migrations_dir: `src/bindings/d1/${name}/drizzle`,
		})),
		kv_namespaces: [{ binding: "CORE_KV" }, { binding: "TURRET_CFG" }],
		r2_buckets: [
			{ binding: "TURRET_REPLAY_BUCKET", bucket_name: "default" },
		],
		flagship: [{ binding: "FLAGS" }],
	};
	writeFileSync(
		path.join(root, "void.config.ts"),
		`export default ${JSON.stringify({ cloudflare: config })};`
	);
	const operations: string[] = [];
	// Flagship goes through Wrangler's CLI, not Void's transport.
	const flagshipCommands: string[] = [];
	let failTurret = true;
	let databaseCount = 0;
	let namespaceCount = 0;
	const options = {
		runFlagship(args: readonly string[]): WranglerResult {
			flagshipCommands.push(args.slice(0, 3).join(" "));
			assert.ok(args.includes("--config"));
			const stdout =
				args[2] === "list"
					? JSON.stringify([
							{ id: "other-app", name: "another-worker" },
						])
					: JSON.stringify({ id: "flagship-app-1", name: args[3] });
			return { status: 0, stdout, stderr: "" };
		},
		async enableD1ReadReplication() {},
		log: { info() {}, warn() {} },
		async runWrangler(operation: {
			type: string;
			configPath: string;
			binding?: string;
			name?: string;
		}) {
			operations.push(operation.type);
			const success = { status: 0, stdout: "", stderr: "" };
			if (operation.type.endsWith(".list"))
				return { ...success, data: [] };
			if (operation.type === "r2.bucket.info")
				return { ...success, status: 1, errorCode: 10006 };
			const resolved = readCloudflareConfig(operation.configPath);
			if (operation.type === "d1.create") {
				if (operation.binding === "TURRET_DB" && failTurret)
					return {
						...success,
						status: 1,
						stderr: "simulated second-database failure",
					};
				const entry = resolved.d1_databases?.find(
					(db) => db.binding === operation.binding
				);
				assert.ok(entry);
				entry.database_id = `${++databaseCount}1111111-1111-4111-8111-111111111111`;
			} else if (operation.type === "kv.namespace.create") {
				const namespace = resolved.kv_namespaces?.find(
					(kv) => kv.binding === operation.binding
				);
				assert.ok(namespace);
				namespace.id = String(++namespaceCount).repeat(32);
			} else if (operation.type === "r2.bucket.create") {
				const bucket = resolved.r2_buckets?.[0];
				assert.ok(bucket);
				bucket.bucket_name = operation.name;
			} else
				throw new Error(
					`Unexpected remote operation: ${operation.type}`
				);
			writeFileSync(operation.configPath, JSON.stringify(resolved));
			return success;
		},
	};
	await assert.rejects(
		provisionResources(root, options),
		/simulated second-database failure/
	);
	const partial = JSON.parse(
		readFileSync(path.join(root, "void.lock.json"), "utf8")
	);
	assert.ok(partial.resolved.d1_databases[0].database_id);
	assert.equal(partial.resolved.d1_databases[1].database_id, undefined);
	assert.deepEqual(flagshipCommands, []);
	failTurret = false;
	const first = await provisionResources(root, options);
	assert.equal(databaseCount, 2);
	assert.equal(namespaceCount, 2);
	const [core, turret] = first.config.d1_databases ?? [];
	assert.ok(core);
	assert.ok(turret);
	assert.notEqual(core.database_id, turret.database_id);
	assert.equal(
		first.config.r2_buckets?.[0]?.bucket_name,
		"fixture-stack-replay"
	);
	const lock = JSON.parse(
		readFileSync(path.join(root, "void.lock.json"), "utf8")
	);
	assert.deepEqual(lock.resolved.d1_databases, first.config.d1_databases);
	assert.deepEqual(lock.resolved.kv_namespaces, first.config.kv_namespaces);
	// No app named after the Worker existed, so one was created and its ID
	// recorded where Void keeps provisioned IDs.
	assert.deepEqual(flagshipCommands, [
		"flagship apps list",
		"flagship apps create",
	]);
	assert.deepEqual(lock.resolved.flagship, [
		{ binding: "FLAGS", app_id: "flagship-app-1" },
	]);
	assert.deepEqual(lock.source.flagship, [{ binding: "FLAGS" }]);
	const createdOperations = operations.filter((type) =>
		type.endsWith(".create")
	);
	assert.equal(createdOperations.length, 6);
	operations.length = 0;
	flagshipCommands.length = 0;
	const second = await provisionResources(root, options);
	assert.deepEqual(second.config, first.config);
	assert.deepEqual(operations, []);
	assert.deepEqual(flagshipCommands, []);

	// A configuration accidentally pointing two bindings at one physical D1
	// must fail before it can provision or apply either migration history.
	assert.throws(
		() =>
			provisioningPlans({
				...first.config,
				d1_databases: [core, turret].map((db) => ({
					...db,
					database_id: core.database_id,
				})),
			}),
		/own database ID/
	);
});

test("Flagship provisioning reuses an app by name and fails with the command to run", (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "stack-flagship-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configPath = path.join(root, ".void-wrangler.jsonc");
	const write = () =>
		writeFileSync(
			configPath,
			`// void:managed-queues:v1:abc\n${JSON.stringify({ name: "fixture-stack", flagship: [{ binding: "FLAGS" }] })}\n`
		);
	const persisted: string[] = [];
	const persist = (directory: string) => persisted.push(directory);
	const ok = (stdout: unknown): WranglerResult => ({
		status: 0,
		stdout: JSON.stringify(stdout),
		stderr: "",
	});

	write();
	const reused = provisionFlagship(root, configPath, persist, (args) => {
		assert.equal(args[2], "list", "an existing app is never recreated");
		return ok([{ id: "existing-app", name: "fixture-stack" }]);
	});
	assert.deepEqual(reused, { appId: "existing-app", action: "reused" });
	assert.deepEqual(persisted, [root]);
	const text = readFileSync(configPath, "utf8");
	assert.match(text, /^\/\/ void:managed-queues:v1:abc\n/);
	assert.deepEqual(readCloudflareConfig(configPath).flagship, [
		{ binding: "FLAGS", app_id: "existing-app" },
	]);
	// A recorded app_id is reused without calling Flagship at all.
	assert.equal(
		provisionFlagship(root, configPath, persist, () => {
			throw new Error("Flagship must not be called");
		}),
		undefined
	);

	write();
	assert.throws(
		() =>
			provisionFlagship(root, configPath, persist, () => ({
				status: 1,
				stdout: "",
				stderr: "Authentication error [code: 10000]",
			})),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Authentication error/);
			assert.match(
				error.message,
				/pnpm exec wrangler flagship apps create fixture-stack/
			);
			assert.match(error.message, /app_id on the\nFLAGS binding/);
			return true;
		}
	);
	write();
	assert.throws(
		() =>
			provisionFlagship(root, configPath, persist, () =>
				ok([
					{ id: "a", name: "fixture-stack" },
					{ id: "b", name: "fixture-stack" },
				])
			),
		/Several Flagship apps are named fixture-stack \(a, b\)/
	);
});
