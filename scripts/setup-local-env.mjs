import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

const filename = ".env";
// Preserve existing checkouts when moving from Wrangler's local secrets file.
if (existsSync(".dev.vars")) {
	if (existsSync(filename))
		throw new Error(
			"Both .dev.vars and .env exist. Merge them into .env before setup."
		);
	renameSync(".dev.vars", filename);
	process.stdout.write("Moved existing local configuration to .env.\n");
}
const exists = existsSync(filename);
const source = readFileSync(exists ? filename : "local.env.example", "utf8");
const configured = dotenv.parse(source).BETTER_AUTH_SECRET;
const usable = (/** @type {string | undefined} */ value) =>
	value !== undefined && value.trim() !== "" && value.trim() !== "replace-me";

if (usable(configured)) {
	process.stdout.write("Preserved local BETTER_AUTH_SECRET.\n");
} else {
	const secret = randomBytes(32).toString("base64url");
	const assignment = `BETTER_AUTH_SECRET="${secret}"`;
	const secretLine =
		/^[\t ]*(?:export[\t ]+)?BETTER_AUTH_SECRET[\t ]*=[\t ]*(?:"(?:\\.|[^"])*"|'[^']*'|`[^`]*`|[^#\r\n]*)/gm;
	const updated = secretLine.test(source)
		? source.replace(
				secretLine,
				(match, offset) =>
					assignment +
					(source[offset + match.length] === "#" ? " " : "")
			)
		: `${source.trimEnd()}\n${assignment}\n`;
	writeFileSync(filename, updated, { mode: 0o600 });
	process.stdout.write("Initialized local BETTER_AUTH_SECRET in .env.\n");
}

if (!exists && usable(configured)) {
	writeFileSync(filename, source, { mode: 0o600 });
}
