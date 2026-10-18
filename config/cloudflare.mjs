import { SECRET_NAMES } from "../src/contracts/secrets.ts";

export const localFlagshipAppId = "the-stack-local";

// Core and Turret have separate D1 databases and migration histories.
export const localCloudflare = {
	name: "the-stack-local",
	main: "./src/worker.ts",
	compatibility_date: "2025-10-08",
	compatibility_flags: ["nodejs_compat", "nodejs_als"],
	observability: {
		enabled: true,
		redact_query_string: true,
		issues: {
			enabled: true,
		},
		logs: {
			enabled: true,
			head_sampling_rate: 1,
			invocation_logs: true,
		},
		traces: {
			enabled: true,
			head_sampling_rate: 0.05,
		},
	},
	upload_source_maps: true,
	assets: {
		binding: "ASSETS",
		directory: "./dist",
	},
	vars: {
		PRODUCT_NAME: "The Stack",
		EMAIL_FROM: "noreply@localhost.test",
		EMAIL_FROM_NAME: "The Stack",
		EMAIL_TRANSPORT: "log",
		APP_ENV: "local",
		APP_URL: "http://localhost:4321",
		ADMIN_EMAIL: "admin@localhost.test",
	},
	d1_databases: [
		{
			binding: "CORE_DB",
			database_name: "core-local",
			database_id: "11111111-1111-1111-1111-111111111111",
			migrations_dir: "./src/bindings/d1/core/drizzle",
		},
		{
			binding: "TURRET_DB",
			database_name: "turret-local",
			database_id: "22222222-2222-2222-2222-222222222222",
			migrations_dir: "./src/bindings/d1/turret/drizzle",
		},
	],
	kv_namespaces: [
		{
			binding: "CORE_KV",
		},
		{
			binding: "TURRET_CFG",
		},
	],
	r2_buckets: [
		{
			binding: "TURRET_REPLAY_BUCKET",
			bucket_name: "turret-replay-local",
		},
	],
	send_email: [
		{
			name: "SEND_EMAIL",
		},
	],
	analytics_engine_datasets: [
		{
			binding: "TURRET_METRICS",
			dataset: "turret_operations_local",
		},
		{
			binding: "TURRET_ANALYTICS",
			dataset: "turret_analytics",
		},
	],
	// Local and browser-test Workers read the local flag store under their
	// persist directory; this id only names the store's app.
	flagship: [
		{
			binding: "FLAGS",
			app_id: localFlagshipAppId,
		},
	],
	triggers: {
		crons: ["0 * * * *"],
	},
	version_metadata: {
		binding: "CF_VERSION_METADATA",
	},
};

export const appName = "the-stack";

// Secrets the production Worker binds from Cloudflare Secrets Store (see
// src/contracts/secrets.ts for each one). Every name listed here must exist
// in the account's store before `pnpm run deploy`, which stops with the
// command to create any that are missing. List optional secrets only once
// you use them; required ones (BETTER_AUTH_SECRET) must stay.
export const productionSecretNames = [
	"BETTER_AUTH_SECRET",
	"BOOTSTRAP_SECRET",
	"TURRET_SIGNING_KEY",
	// "RESEND_API_KEY",
	// "GOOGLE_CLIENT_ID",
	// "GOOGLE_CLIENT_SECRET",
];

// Wrangler requires a store_id on every Secrets Store binding, even to build.
// `pnpm run deploy` replaces this placeholder with the account's store and
// records the ID in void.lock.json, like the D1 IDs. Set a real store ID here
// only to choose between several stores.
export const SECRETS_STORE_ID_UNPROVISIONED =
	"unprovisioned-run-pnpm-run-deploy";

// A store belongs to the account, not the Worker, so each app's secret names
// carry its own prefix: THE_STACK_BETTER_AUTH_SECRET binds as
// BETTER_AUTH_SECRET. Two apps (or a staging copy) in one account never share
// a value by accident.
export const secretsStorePrefix = `${appName.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_")}_`;

for (const name of productionSecretNames)
	if (!SECRET_NAMES.some((known) => known === name))
		throw new Error(
			`config/cloudflare.mjs: ${name} is not declared in src/contracts/secrets.ts.`
		);

export const deploymentCloudflare = {
	name: appName,
	main: "./src/worker.ts",
	compatibility_date: "2025-10-08",
	compatibility_flags: ["nodejs_compat", "nodejs_als"],
	observability: {
		enabled: true,
		redact_query_string: true,
		issues: {
			enabled: true,
		},
		logs: {
			enabled: true,
			head_sampling_rate: 1,
			invocation_logs: true,
		},
		traces: {
			enabled: true,
			head_sampling_rate: 0.05,
		},
	},
	upload_source_maps: true,
	// How the Worker is reached. Void requires all three before it replaces a
	// version it did not upload (scripts/lib/worker-traffic.ts), and with them
	// every deploy states the traffic instead of inheriting manual changes.
	// The values are what Wrangler and Cloudflare chose when these were left
	// out:
	// - routes: none. Add your custom domain here, e.g.
	//   { pattern: "your-app.example", custom_domain: true }; routes added in
	//   the dashboard are removed by the next deploy.
	// - workers_dev: Wrangler enables <name>.<subdomain>.workers.dev when a
	//   Worker has no routes. Set false once a custom domain serves APP_URL.
	// - preview_urls: Cloudflare enables version preview URLs with workers.dev
	//   when the setting is absent, so a version can be checked on its own URL
	//   before it takes traffic.
	routes: [],
	workers_dev: true,
	preview_urls: true,
	assets: {
		binding: "ASSETS",
		directory: "./dist",
	},
	vars: {
		PRODUCT_NAME: "The Stack",
		EMAIL_FROM: "noreply@your-app.example",
		EMAIL_FROM_NAME: "The Stack",
		EMAIL_TRANSPORT: "cloudflare",
		APP_ENV: "production",
		APP_URL: "https://your-app.example",
		ADMIN_EMAIL: "admin@your-app.example",
	},
	d1_databases: [
		{
			binding: "CORE_DB",
			database_name: `${appName}-core`,
			migrations_dir: "./src/bindings/d1/core/drizzle",
		},
		{
			binding: "TURRET_DB",
			database_name: `${appName}-turret`,
			migrations_dir: "./src/bindings/d1/turret/drizzle",
		},
	],
	kv_namespaces: [
		{
			binding: "CORE_KV",
		},
		{
			binding: "TURRET_CFG",
		},
	],
	r2_buckets: [
		{
			binding: "TURRET_REPLAY_BUCKET",
			bucket_name: "default",
		},
	],
	analytics_engine_datasets: [
		{
			binding: "TURRET_METRICS",
			dataset: "turret_operations",
		},
		{
			binding: "TURRET_ANALYTICS",
			dataset: "turret_analytics",
		},
	],
	// `pnpm run deploy` creates or reuses the Flagship app named after the
	// Worker and records its app_id in void.lock.json, like the D1 IDs.
	flagship: [
		{
			binding: "FLAGS",
		},
	],
	triggers: {
		crons: ["0 * * * *"],
	},
	version_metadata: {
		binding: "CF_VERSION_METADATA",
	},
	analytics: {
		binding: "ANALYTICS_SQL",
	},
	// Never plain Worker secrets (`wrangler secret put`, `void secret put`):
	// Void pins those on the next deploy and its uploader cannot upload FLAGS
	// or ANALYTICS_SQL. `pnpm check:deploy` and `pnpm run deploy` refuse them.
	secrets_store_secrets: productionSecretNames.map((name) => ({
		binding: name,
		store_id: SECRETS_STORE_ID_UNPROVISIONED,
		secret_name: `${secretsStorePrefix}${name}`,
	})),
};
