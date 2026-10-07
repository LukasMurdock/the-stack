import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";

const filename = ".dev.vars";
const exists = existsSync(filename);
const source = readFileSync(exists ? filename : ".dev.vars.example", "utf8");
const configured = dotenv.parse(source).BETTER_AUTH_SECRET;
const usable = (value) =>
	Boolean(value?.trim()) && value.trim() !== "replace-me";

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
	process.stdout.write(
		"Initialized local BETTER_AUTH_SECRET in .dev.vars.\n"
	);
}

if (!exists && usable(configured)) {
	writeFileSync(filename, source, { mode: 0o600 });
}
