import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { localConfigPath } from "./local-cloudflare.mjs";

execFileSync(
	"pnpm",
	[
		"exec",
		"wrangler",
		"types",
		"--strict-vars=false",
		"--config",
		localConfigPath,
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
