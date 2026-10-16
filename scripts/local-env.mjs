import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { localCloudflare } from "../config/cloudflare.mjs";
import { z } from "zod";

export function loadLocalEnv() {
	const { vars } = z
		.object({ vars: z.record(z.string(), z.string()) })
		.parse(localCloudflare);
	const loaded = existsSync(".env")
		? dotenv.config({ path: ".env", quiet: true })
		: { parsed: {} };
	for (const [key, value] of Object.entries(vars)) process.env[key] ??= value;
	return loaded;
}
