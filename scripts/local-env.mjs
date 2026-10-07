import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import ts from "typescript";
import { z } from "zod";

export function loadLocalEnv() {
	const configuration = ts.parseConfigFileTextToJson(
		"wrangler.json",
		readFileSync("wrangler.json", "utf8")
	);
	if (configuration.error)
		throw new Error("wrangler.json is not valid JSONC");
	const { vars } = z
		.object({ vars: z.record(z.string(), z.string()) })
		.parse(configuration.config);
	const loaded = existsSync(".dev.vars")
		? dotenv.config({ path: ".dev.vars", quiet: true })
		: { parsed: {} };
	for (const [key, value] of Object.entries(vars)) process.env[key] ??= value;
	return loaded;
}
