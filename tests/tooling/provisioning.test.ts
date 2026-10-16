import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deploymentCloudflare } from "../../config/cloudflare.mjs";
import {
	provisionResources,
	provisioningPlans,
	readCloudflareConfig,
} from "../../scripts/provision-resources.mjs";

type DatabaseBinding = {
	binding: string;
	database_name: string;
	database_id: string;
	migrations_dir: string;
};

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
	assert.notEqual(Reflect.get(declared[0], "r2").bucketName, "default");
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
	};
	writeFileSync(
		path.join(root, "void.config.ts"),
		`export default ${JSON.stringify({ cloudflare: config })};`
	);
	const operations: string[] = [];
	let failTurret = true;
	let databaseCount = 0;
	let namespaceCount = 0;
	const options = {
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
				const entry = resolved.d1_databases.find(
					(db: { binding: string }) =>
						db.binding === operation.binding
				);
				entry.database_id = `${++databaseCount}1111111-1111-4111-8111-111111111111`;
			} else if (operation.type === "kv.namespace.create") {
				resolved.kv_namespaces.find(
					(kv: { binding: string }) =>
						kv.binding === operation.binding
				).id = String(++namespaceCount).repeat(32);
			} else if (operation.type === "r2.bucket.create") {
				resolved.r2_buckets[0].bucket_name = operation.name;
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
	failTurret = false;
	const first = await provisionResources(root, options);
	assert.equal(databaseCount, 2);
	assert.equal(namespaceCount, 2);
	assert.notEqual(
		first.config.d1_databases[0].database_id,
		first.config.d1_databases[1].database_id
	);
	assert.equal(
		first.config.r2_buckets[0].bucket_name,
		"fixture-stack-replay"
	);
	const lock = JSON.parse(
		readFileSync(path.join(root, "void.lock.json"), "utf8")
	);
	assert.deepEqual(lock.resolved.d1_databases, first.config.d1_databases);
	assert.deepEqual(lock.resolved.kv_namespaces, first.config.kv_namespaces);
	const createdOperations = operations.filter((type) =>
		type.endsWith(".create")
	);
	assert.equal(createdOperations.length, 6);
	operations.length = 0;
	const second = await provisionResources(root, options);
	assert.deepEqual(second.config, first.config);
	assert.deepEqual(operations, []);

	// A configuration accidentally pointing two bindings at one physical D1
	// must fail before it can provision or apply either migration history.
	assert.throws(
		() =>
			provisioningPlans({
				...first.config,
				d1_databases: first.config.d1_databases.map(
					(db: DatabaseBinding) => ({
						...db,
						database_id: first.config.d1_databases[0].database_id,
					})
				),
			}),
		/own database ID/
	);
});
