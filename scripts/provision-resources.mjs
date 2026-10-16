import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadVoidProvisioning } from "./lib/void-cloudflare.mjs";

export function readCloudflareConfig(configPath) {
	const parsed = ts.parseConfigFileTextToJson(
		configPath,
		readFileSync(configPath, "utf8")
	);
	if (parsed.error)
		throw new Error(`Invalid Cloudflare configuration: ${configPath}`);
	return parsed.config;
}

export function assertSeparateDatabases(config) {
	const databases = config.d1_databases ?? [];
	const ids = databases
		.map((db) => db.database_id?.toLowerCase())
		.filter(Boolean);
	if (new Set(ids).size !== ids.length)
		throw new Error(
			"Each D1 binding must have its own database ID; Core and Turret cannot share one."
		);
	const names = databases.map((db) => db.database_name);
	if (new Set(names).size !== names.length)
		throw new Error("Each D1 binding must have its own database name.");
}

export function provisioningPlans(config) {
	assertSeparateDatabases(config);
	const plans = (config.d1_databases ?? []).map((database) => ({
		d1: {
			binding: database.binding,
			name: database.database_name,
			migrationsDir: database.migrations_dir,
		},
		kvNamespaces: [],
		queues: [],
	}));
	if (!plans.length)
		throw new Error(
			"Declare the application's D1 databases before deploying."
		);
	plans[0].kvNamespaces = (config.kv_namespaces ?? []).map((namespace) => ({
		binding: namespace.binding,
		title: `${config.name}-${namespace.binding.toLowerCase().replaceAll("_", "-")}`,
	}));
	const buckets = config.r2_buckets ?? [];
	if (buckets.length > 1)
		throw new Error(
			"This Void adapter currently supports one replay bucket."
		);
	if (buckets.length)
		plans[0].r2 = {
			binding: buckets[0].binding,
			bucketName:
				buckets[0].bucket_name && buckets[0].bucket_name !== "default"
					? buckets[0].bucket_name
					: `${config.name}-replay`,
		};
	return plans;
}

export async function provisionResources(root = process.cwd(), options = {}) {
	const sdk = await loadVoidProvisioning();
	const configPath = sdk.materializeCloudflareConfig(root);
	const config = readCloudflareConfig(configPath);
	for (const plan of provisioningPlans(config)) {
		const result = await sdk.provisionCloudflareResources(
			root,
			configPath,
			plan,
			{
				...options,
				accountId: config.account_id,
			}
		);
		if (result.resources.some((resource) => resource.action === "skipped"))
			throw new Error(
				"Void could not provision every required resource. Deployment stopped."
			);
	}
	const resolved = readCloudflareConfig(configPath);
	assertSeparateDatabases(resolved);
	return { configPath, config: resolved };
}
