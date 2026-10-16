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
};
