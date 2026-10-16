import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localConfigPath } from "./local-cloudflare.mjs";

execFileSync(
	"pnpm",
	[
		"exec",
		"wrangler",
		"types",
		"--strict-vars=false",
		"--config",
		// Relative, so the generated header does not name this machine's path.
		path.relative(process.cwd(), localConfigPath),
	],
	{
		stdio: "inherit",
	}
);
// Keep generated runtime declarations stable under repository whitespace checks.
const filename = "worker-configuration.d.ts";
writeFileSync(
	filename,
	readFileSync(filename, "utf8").replace(/[\t ]+$/gm, "")
);
