// Streams the deployed Worker's logs with `wrangler tail`. The Worker name
// comes from config/cloudflare.mjs, so a fork that renames its app tails its
// own Worker. Arguments pass through unchanged: wrangler owns and validates
// them (`pnpm logs --format json`, `pnpm logs --help`).

import { spawn } from "node:child_process";
import { appName } from "../config/cloudflare.mjs";
import { EXIT_CODE_FAILURE, errorCode, isEntryPoint } from "./lib/cli.ts";

export function wranglerTailArgs(argv: readonly string[]): readonly string[] {
	return ["tail", appName, ...argv];
}

function main(): void {
	// pnpm puts node_modules/.bin on PATH, so this resolves the pinned wrangler.
	const child = spawn("wrangler", wranglerTailArgs(process.argv.slice(2)), {
		stdio: "inherit",
	});
	child.on("error", (error: Error) => {
		const hint =
			errorCode(error) === "ENOENT"
				? "wrangler was not found on PATH; run this as `pnpm logs`."
				: error.message;
		process.stderr.write(`${hint}\n`);
		process.exitCode = EXIT_CODE_FAILURE;
	});
	child.on("exit", (code, signal) => {
		if (code !== null) process.exitCode = code;
		else if (signal !== null) process.exitCode = EXIT_CODE_FAILURE;
	});
}

if (isEntryPoint(import.meta.url)) main();
