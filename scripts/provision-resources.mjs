import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import { SECRETS_STORE_ID_UNPROVISIONED } from "../config/cloudflare.mjs";
import { ensureFlagshipApp, runWrangler } from "./lib/flagship.ts";
import {
	ensureSecretsStore,
	listStoreSecretNames,
	listWorkerPlainSecrets,
	missingSecretsHelp,
	parseSecretsConfig,
	plainSecretsSwitchHelp,
	secretsConfigProblems,
} from "./lib/secrets-store.ts";
import { loadVoidProvisioning } from "./lib/void-cloudflare.ts";
import { trafficConfigProblems } from "./lib/worker-traffic.ts";

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
	secrets_store_secrets: z
		.array(
			z.looseObject({
				binding: z.string(),
				store_id: z.string(),
				secret_name: z.string(),
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
	return cloudflareConfigSchema.parse(readCloudflareConfigValue(configPath));
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
	rewriteMaterializedConfig(configPath, (config) => {
		const parsed = z
			.looseObject({
				flagship: z.array(z.looseObject({ binding: z.string() })),
			})
			.parse(config);
		return {
			...parsed,
			flagship: parsed.flagship.map((entry) =>
				entry.binding === bindingName
					? { ...entry, app_id: appId }
					: entry
			),
		};
	});
}

/**
 * @param {string} configPath
 * @param {(config: unknown) => Record<string, unknown>} change
 */
function rewriteMaterializedConfig(configPath, change) {
	const text = readFileSync(configPath, "utf8");
	const provenance = text.match(/^\s*\/\/ void:.*$/gm) ?? [];
	const parsed = ts.parseConfigFileTextToJson(configPath, text);
	if (parsed.error)
		throw new Error(`Invalid Cloudflare configuration: ${configPath}`);
	const config = change(parsed.config);
	const lines = provenance.map((line) => `${line.trim()}\n`).join("");
	writeFileSync(configPath, `${lines}${JSON.stringify(config, null, 2)}\n`);
}

// Void 1.1 cannot provision Secrets Store and Wrangler requires a store_id on
// every binding, so config/cloudflare.mjs carries a placeholder. Before Void
// publishes, this refuses plain Worker secrets (in the config or on the live
// Worker; see scripts/lib/secrets-store.ts for why), resolves the placeholder
// to the account's store, confirms each bound secret exists there, and has
// Void record the store ID in void.lock.json.
/**
 * @param {string} root
 * @param {string} configPath
 * @param {(root: string) => void} persistCloudflareConfig
 * @param {import("./lib/flagship.ts").WranglerRunner} run
 */
export function provisionSecretsStore(
	root,
	configPath,
	persistCloudflareConfig,
	run
) {
	const raw = readCloudflareConfigValue(configPath);
	const problems = secretsConfigProblems(raw, root);
	if (problems.length > 0) throw new Error(problems.join("\n"));
	const config = parseSecretsConfig(raw);
	const entries = config.secrets_store_secrets ?? [];
	const unprovisioned = entries.some(
		(entry) => entry.store_id === SECRETS_STORE_ID_UNPROVISIONED
	);
	const store = unprovisioned
		? ensureSecretsStore({ configPath }, run)
		: undefined;
	const resolved = entries.map((entry) =>
		store !== undefined && entry.store_id === SECRETS_STORE_ID_UNPROVISIONED
			? { ...entry, store_id: store.storeId }
			: entry
	);
	assertSecretsExist(resolved, configPath, run);
	const plain = listWorkerPlainSecrets(
		{ workerName: config.name, configPath },
		run
	);
	if (store !== undefined)
		recordSecretsStore(
			root,
			configPath,
			store.storeId,
			persistCloudflareConfig
		);
	// After recording the store, so the switch's own build binds it.
	if (plain.length > 0)
		throw new Error(plainSecretsSwitchHelp(config.name, plain));
	return store;
}

// Puts the store ID in place of SECRETS_STORE_ID_UNPROVISIONED in the
// materialized config and has Void record it in void.lock.json, where later
// builds (deploy's, and the switch's) read it.
/**
 * @param {string} root
 * @param {string} configPath
 * @param {string} storeId
 * @param {(root: string) => void} persistCloudflareConfig
 */
export function recordSecretsStore(
	root,
	configPath,
	storeId,
	persistCloudflareConfig
) {
	rewriteMaterializedConfig(configPath, (value) => {
		const config = parseSecretsConfig(value);
		return {
			...config,
			secrets_store_secrets: (config.secrets_store_secrets ?? []).map(
				(entry) =>
					entry.store_id === SECRETS_STORE_ID_UNPROVISIONED
						? { ...entry, store_id: storeId }
						: entry
			),
		};
	});
	persistCloudflareConfig(root);
}

/**
 * @param {readonly { binding: string; store_id: string; secret_name: string }[]} entries
 * @param {string} configPath
 * @param {import("./lib/flagship.ts").WranglerRunner} run
 */
function assertSecretsExist(entries, configPath, run) {
	const help = [];
	for (const storeId of new Set(entries.map((entry) => entry.store_id))) {
		const names = listStoreSecretNames({ storeId, configPath }, run);
		const missing = entries
			.filter((entry) => entry.store_id === storeId)
			.filter((entry) => !names.has(entry.secret_name))
			.map((entry) => ({
				binding: entry.binding,
				secretName: entry.secret_name,
			}));
		const text = missingSecretsHelp(storeId, missing);
		if (text !== "") help.push(text);
	}
	if (help.length > 0) throw new Error(help.join("\n"));
}

/** @param {string} configPath */
function readCloudflareConfigValue(configPath) {
	const parsed = ts.parseConfigFileTextToJson(
		configPath,
		readFileSync(configPath, "utf8")
	);
	if (parsed.error)
		throw new Error(`Invalid Cloudflare configuration: ${configPath}`);
	return parsed.config;
}

/**
 * @param {string} [root]
 * @param {Record<string, unknown> & { runFlagship?: import("./lib/flagship.ts").WranglerRunner; runSecretsStore?: import("./lib/flagship.ts").WranglerRunner }} [options]
 */
export async function provisionResources(root = process.cwd(), options = {}) {
	const {
		runFlagship = runWrangler,
		runSecretsStore = runWrangler,
		...voidOptions
	} = options;
	const sdk = await loadVoidProvisioning();
	const configPath = sdk.materializeCloudflareConfig(root);
	// Refuse plain secrets and undeclared traffic before creating anything.
	const raw = readCloudflareConfigValue(configPath);
	const problems = [
		...secretsConfigProblems(raw, root),
		...trafficConfigProblems(raw),
	];
	if (problems.length > 0) throw new Error(problems.join("\n"));
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
	const store = provisionSecretsStore(
		root,
		configPath,
		sdk.persistCloudflareConfig,
		runSecretsStore
	);
	if (store !== undefined)
		process.stdout.write(
			`Secrets Store ${store.action === "created" ? "created" : "found"}: ${store.storeId} (recorded in void.lock.json)\n`
		);
	const resolved = readCloudflareConfig(configPath);
	assertSeparateDatabases(resolved);
	return { configPath, config: resolved };
}
