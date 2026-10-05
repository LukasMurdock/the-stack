import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		local: { type: "boolean" },
		remote: { type: "boolean" },
		env: { type: "string" },
		"writes-paused": { type: "boolean" },
	},
});
if (
	Boolean(values.local) === Boolean(values.remote) ||
	!values["writes-paused"]
) {
	throw new Error(
		"Usage: node scripts/migrate-auth-storage.mjs (--local | --remote --env production) --writes-paused. Stop all auth traffic before running."
	);
}
if (values.remote && !values.env)
	throw new Error("Remote migration requires --env");

const target = [
	"--config",
	"wrangler.json",
	values.local ? "--local" : "--remote",
	...(values.env ? ["--env", values.env] : []),
];
function wrangler(args) {
	try {
		return execFileSync("pnpm", ["exec", "wrangler", ...args, ...target], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		});
	} catch {
		// Captured Wrangler errors can include SQL containing session secrets.
		throw new Error(
			`Wrangler ${args.slice(0, 3).join(" ")} failed; verify bindings, credentials, and applied D1 migrations. Auth traffic must remain paused.`
		);
	}
}
const keys = JSON.parse(
	wrangler(["kv", "key", "list", "--binding", "CORE_KV"])
);
// Wrangler's local list only returns one page; never silently truncate a copy.
if (values.local && keys.length >= 1000)
	throw new Error(
		"Local KV has at least 1000 keys; use a paginated export before migrating."
	);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const directory = mkdtempSync(join(tmpdir(), "auth-storage-"));
let copied = 0;
try {
	// Verify the target before reading any credentials out of KV.
	wrangler([
		"d1",
		"execute",
		"CORE_DB",
		"--command",
		"SELECT key FROM auth_storage LIMIT 0",
	]);
	for (let offset = 0; offset < keys.length; offset += 50) {
		const statements = [];
		for (const { name, expiration } of keys.slice(offset, offset + 50)) {
			if (
				name.startsWith("bootstrap:") ||
				(expiration && expiration <= Date.now() / 1000)
			)
				continue;
			if (expiration !== undefined && !Number.isSafeInteger(expiration))
				throw new Error("Invalid KV expiration");
			const value = wrangler([
				"kv",
				"key",
				"get",
				name,
				"--binding",
				"CORE_KV",
			]);
			if (value === "Value not found\n") continue;
			const expiresAt = expiration ?? "NULL";
			statements.push(
				`INSERT INTO auth_storage (key, value, expires_at) SELECT ${quote(name)}, ${quote(value)}, ${expiresAt} WHERE ${expiresAt} IS NULL OR ${expiresAt} > unixepoch() ON CONFLICT(key) DO NOTHING;`
			);
		}
		if (!statements.length) continue;
		const file = join(directory, "batch.sql");
		writeFileSync(file, statements.join("\n"), { mode: 0o600 });
		wrangler(["d1", "execute", "CORE_DB", "--file", file]);
		copied += statements.length;
	}
	console.log(
		`Processed ${copied} unexpired KV records for D1 (existing D1 keys retained). KV is unchanged. Deploy the new Worker before resuming auth traffic; do not rerun after cutover.`
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
