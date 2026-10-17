import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localCloudflare } from "../config/cloudflare.mjs";

// Wrangler and the Cloudflare Vite plugin read local secrets (`.env`) from the
// config file's directory, so the generated file sits beside `.env` in the
// project root. Its name must not start with `wrangler`: Void treats a root
// wrangler.json(c) as a config to migrate.
export const localConfigPath = path.resolve(".wrangler-local.json");

export function writeLocalCloudflareConfig() {
	const config = structuredClone(localCloudflare);
	config.main = path.resolve(config.main);
	config.assets.directory = path.resolve(config.assets.directory);
	for (const database of config.d1_databases)
		database.migrations_dir = path.resolve(database.migrations_dir);
	mkdirSync(path.dirname(localConfigPath), { recursive: true });
	writeFileSync(localConfigPath, JSON.stringify(config, null, 2));
	return localConfigPath;
}

writeLocalCloudflareConfig();
