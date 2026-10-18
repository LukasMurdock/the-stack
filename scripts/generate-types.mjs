import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { localConfigPath } from "./local-cloudflare.mjs";

// Wrangler reads the local .env by default and adds every variable in it to
// Env as a required string. Local .env files carry secrets the code types as
// optional Store bindings, so on any machine that ran `pnpm local:setup` the
// generated types disagreed with the code. An empty env file keeps the output
// identical on every machine. Wrangler runs through node, not `pnpm exec`,
// because pnpm claims `--env-file` as its own flag.
const require = createRequire(import.meta.url);
const wranglerCli = path.join(
	path.dirname(require.resolve("wrangler/package.json")),
	"bin",
	"wrangler.js"
);
execFileSync(
	process.execPath,
	[
		wranglerCli,
		"types",
		"--strict-vars=false",
		"--config",
		// Relative, so the generated header does not name this machine's path.
		path.relative(process.cwd(), localConfigPath),
		"--env-file",
		path.join("config", "typegen.env"),
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
