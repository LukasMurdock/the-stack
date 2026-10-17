import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import { ensureFlagshipApp, runWrangler } from "./lib/flagship.ts";
import { loadVoidProvisioning } from "./lib/void-cloudflare.ts";

const cloudflareConfigSchema = z.looseObject({
	name: z.string(),
	account_id: z.string().optional(),
	d1_databases: z
		.array(
			z.looseObject({
				binding: z.string(),
				database_name: z.string(),
				database_id: z.string().optional(),
				migrations_dir: z.string(),
			})
		)
		.optional(),
	kv_namespaces: z.array(z.looseObject({ binding: z.string() })).optional(),
	r2_buckets: z
		.array(
			z.looseObject({
				binding: z.string(),
				bucket_name: z.string().optional(),
			})
		)
		.optional(),
	flagship: z
		.array(
			z.looseObject({
				binding: z.string(),
				app_id: z.string().optional(),
			})
		)
		.optional(),
});
/** @typedef {z.infer<typeof cloudflareConfigSchema>} CloudflareConfig */

/**
 * @typedef {{
 *   d1: { binding: string; name: string; migrationsDir: string };
 *   kvNamespaces: { binding: string; title: string }[];
 *   queues: never[];
 *   r2?: { binding: string; bucketName: string };
 * }} ProvisioningPlan
 */

/**
 * @param {string} configPath
 * @returns {CloudflareConfig}
 */
export function readCloudflareConfig(configPath) {
	const parsed = ts.parseConfigFileTextToJson(
		configPath,
		readFileSync(configPath, "utf8")
	);
	if (parsed.error)
		throw new Error(`Invalid Cloudflare configuration: ${configPath}`);
	return cloudflareConfigSchema.parse(parsed.config);
}

/** @param {CloudflareConfig} config */
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

/** @param {CloudflareConfig} config */
function replayBucket(config) {
	const buckets = config.r2_buckets ?? [];
	if (buckets.length > 1)
		throw new Error(
			"This Void adapter currently supports one replay bucket."
		);
	const [bucket] = buckets;
	if (bucket === undefined) return undefined;
	return {
		binding: bucket.binding,
		bucketName:
			bucket.bucket_name && bucket.bucket_name !== "default"
				? bucket.bucket_name
				: `${config.name}-replay`,
	};
}

/**
 * @param {CloudflareConfig} config
 * @returns {ProvisioningPlan[]}
 */
export function provisioningPlans(config) {
	assertSeparateDatabases(config);
	/** @type {ProvisioningPlan[]} */
	const plans = (config.d1_databases ?? []).map((database) => ({
		d1: {
			binding: database.binding,
			name: database.database_name,
			migrationsDir: database.migrations_dir,
		},
		kvNamespaces: [],
		queues: [],
	}));
	// The first plan also carries the app's shared KV namespaces and bucket.
	const [primary] = plans;
	if (primary === undefined)
		throw new Error(
			"Declare the application's D1 databases before deploying."
		);
	primary.kvNamespaces = (config.kv_namespaces ?? []).map((namespace) => ({
		binding: namespace.binding,
		title: `${config.name}-${namespace.binding.toLowerCase().replaceAll("_", "-")}`,
	}));
	const r2 = replayBucket(config);
	if (r2 !== undefined) primary.r2 = r2;
	return plans;
}

// Void 1.1 has no Flagship provisioning and refuses to deploy a flagship
// binding without an app ID, so the adapter finds or creates the app named
// after the Worker, writes its app_id into the materialized config, and has
// Void record it in void.lock.json. Later deploys reuse the recorded ID.
/**
 * @param {string} root
 * @param {string} configPath
 * @param {(root: string) => void} persistCloudflareConfig
 * @param {import("./lib/flagship.ts").WranglerRunner} runFlagship
 */
export function provisionFlagship(
	root,
	configPath,
	persistCloudflareConfig,
	runFlagship
) {
	const config = readCloudflareConfig(configPath);
	const bindings = config.flagship ?? [];
	if (bindings.length > 1)
		throw new Error(
			"This adapter provisions one Flagship binding (FLAGS)."
		);
	const [binding] = bindings;
	if (binding === undefined || binding.app_id) return undefined;
	const app = ensureFlagshipApp(
		{ appName: config.name, configPath },
		runFlagship
	);
	writeFlagshipAppId(configPath, binding.binding, app.appId);
	persistCloudflareConfig(root);
	return app;
}

// The materialized file is Void's `// void:` provenance lines followed by
// JSON; keep the lines and rewrite the JSON with the app ID added.
/**
 * @param {string} configPath
 * @param {string} bindingName
 * @param {string} appId
 */
function writeFlagshipAppId(configPath, bindingName, appId) {
	const text = readFileSync(configPath, "utf8");
	const provenance = text.match(/^\s*\/\/ void:.*$/gm) ?? [];
	const parsed = ts.parseConfigFileTextToJson(configPath, text);
	if (parsed.error)
		throw new Error(`Invalid Cloudflare configuration: ${configPath}`);
	const config = z
		.looseObject({
			flagship: z.array(z.looseObject({ binding: z.string() })),
		})
		.parse(parsed.config);
	config.flagship = config.flagship.map((entry) =>
		entry.binding === bindingName ? { ...entry, app_id: appId } : entry
	);
	const lines = provenance.map((line) => `${line.trim()}\n`).join("");
	writeFileSync(configPath, `${lines}${JSON.stringify(config, null, 2)}\n`);
}

/**
 * @param {string} [root]
 * @param {Record<string, unknown> & { runFlagship?: import("./lib/flagship.ts").WranglerRunner }} [options]
 */
export async function provisionResources(root = process.cwd(), options = {}) {
	const { runFlagship = runWrangler, ...voidOptions } = options;
	const sdk = await loadVoidProvisioning();
	const configPath = sdk.materializeCloudflareConfig(root);
	const config = readCloudflareConfig(configPath);
	for (const plan of provisioningPlans(config)) {
		const result = await sdk.provisionCloudflareResources(
			root,
			configPath,
			plan,
			{
				...voidOptions,
				accountId: config.account_id,
			}
		);
		if (
			result.resources.some(
				(/** @type {{ action: string }} */ resource) =>
					resource.action === "skipped"
			)
		)
			throw new Error(
				"Void could not provision every required resource. Deployment stopped."
			);
	}
	const flagship = provisionFlagship(
		root,
		configPath,
		sdk.persistCloudflareConfig,
		runFlagship
	);
	if (flagship !== undefined)
		process.stdout.write(
			`Flagship app ${flagship.action === "created" ? "created" : "found"} for ${config.name}: ${flagship.appId} (recorded in void.lock.json)\n`
		);
	const resolved = readCloudflareConfig(configPath);
	assertSeparateDatabases(resolved);
	return { configPath, config: resolved };
}
