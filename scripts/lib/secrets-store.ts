// Production secrets live in Cloudflare Secrets Store. Plain Worker secrets
// (`secret_text`, from `wrangler secret put` or `void secret put`) break Void
// 1.1: when the live Worker has any, Void pins them and uploads through its
// own uploader, which knows only the binding types in VOID_PINNED_UPLOAD_TYPES
// and fails on FLAGS (Flagship) and ANALYTICS_SQL. Without plain secrets Void
// uploads through Wrangler, which supports every binding.
//
// This module holds the guards (pure, used by `pnpm check:deploy` and by
// deploy provisioning) and the Wrangler calls deploy uses to find the
// account's store and confirm each bound secret exists. Wrangler prints
// Secrets Store listings only as tables, so parseWranglerTable reads them.

import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	requiredSecretNames,
	secretCreateCommand,
} from "../../src/contracts/secrets.ts";
import { CommandError } from "./cli.ts";
import type { WranglerResult, WranglerRunner } from "./flagship.ts";

// Build-output binding types Void 1.1.11's pinned-secret uploader can upload
// (bindingsFromOutput in void/dist/deploy-*.mjs). Recheck when upgrading Void.
export const VOID_PINNED_UPLOAD_TYPES: readonly string[] = [
	"text",
	"json",
	"kv",
	"d1",
	"r2",
	"durable-object",
	"queue",
	"ai",
	"browser",
	"images",
	"hyperdrive",
	"worker",
	"workflow",
	"send-email",
	"analytics-engine-dataset",
	"vectorize",
	"dispatch-namespace",
	"assets",
	"version-metadata",
];
// "secret" in a build output; "secret_text"/"secret_key" in Cloudflare's API.
export const PLAIN_SECRET_TYPES: readonly string[] = [
	"secret",
	"secret_text",
	"secret_key",
];

// Cloudflare's own name for the store it creates for an account.
export const DEFAULT_STORE_NAME = "default_secrets_store";
// Wrangler's largest page; the pages bound a listing that never ends.
export const LIST_PAGE_SIZE = 100;
export const LIST_PAGES_MAX = 10;
export const TABLE_ROWS_MAX = LIST_PAGE_SIZE;
const OUTPUT_TAIL_CHARS = 2_000;
// Wrangler's "Worker not found" API errors (as Void's own secret listing).
const WORKER_NOT_FOUND = /\[code: (?:10007|10090)\]/;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const PINNING_EXPLANATION =
	'Void pins a live Worker\'s plain secrets on the next deploy and uploads through its own uploader, which cannot upload FLAGS (Flagship) or ANALYTICS_SQL, so that deploy fails. Production secrets live in Cloudflare Secrets Store instead (secrets_store_secrets; docs/DEPLOYMENT_GUIDE.md, "Secrets").';

const configSchema = z.looseObject({
	name: z.string().min(1),
	secrets: z
		.looseObject({ required: z.array(z.string()).optional() })
		.optional(),
	secrets_store_secrets: z
		.array(
			z.looseObject({
				binding: z.string().min(1),
				store_id: z.string().min(1),
				secret_name: z.string().min(1),
			})
		)
		.optional(),
});
export type SecretsConfig = z.infer<typeof configSchema>;

export function parseSecretsConfig(config: unknown): SecretsConfig {
	return configSchema.parse(config);
}

// Every way the production config would create or require plain Worker
// secrets, and every required secret it does not bind from the Store.
export function secretsConfigProblems(
	config: unknown,
	root: string
): readonly string[] {
	const parsed = parseSecretsConfig(config);
	const problems: string[] = [];
	const required = parsed.secrets?.required ?? [];
	if (required.length > 0)
		problems.push(
			`The config declares plain Worker secrets (secrets.required: ${required.join(", ")}). ${PINNING_EXPLANATION}`
		);
	// Void reads env.ts as the env schema and demands its keys as Worker
	// secrets before publishing.
	if (existsSync(path.join(root, "env.ts")))
		problems.push(
			`env.ts declares an env schema, whose keys Void requires as plain Worker secrets. ${PINNING_EXPLANATION} Declare secrets in src/contracts/secrets.ts and remove env.ts.`
		);
	const bound = new Set(
		(parsed.secrets_store_secrets ?? []).map((entry) => entry.binding)
	);
	for (const name of requiredSecretNames())
		if (!bound.has(name))
			problems.push(
				`The config does not bind the required secret ${name} from Secrets Store; add it to productionSecretNames in config/cloudflare.mjs.`
			);
	return problems;
}

// Problems with a built Worker's bindings (name -> build-output type): any
// plain secret, and, when there are plain secrets, every binding Void's
// pinned uploader would refuse.
export function artifactSecretProblems(
	bindings: ReadonlyMap<string, string>
): readonly string[] {
	const plain = [...bindings].filter(([, type]) =>
		PLAIN_SECRET_TYPES.includes(type)
	);
	if (plain.length === 0) return [];
	const problems = [
		`The Worker has plain secret bindings (${plain.map(([name, type]) => `${name}: ${type}`).join(", ")}). ${PINNING_EXPLANATION}`,
	];
	for (const [name, type] of bindings)
		if (
			!PLAIN_SECRET_TYPES.includes(type) &&
			!VOID_PINNED_UPLOAD_TYPES.includes(type)
		)
			problems.push(
				`${name} is a ${type} binding, which Void cannot upload while plain secrets are pinned.`
			);
	return problems;
}

// --- Wrangler output ---------------------------------------------------------

// Rows of the first table in Wrangler's output (cli-table3 box drawing), keyed
// by the header row. Banner and log lines around the table are ignored.
export function parseWranglerTable(
	text: string
): readonly Readonly<Record<string, string>>[] {
	const lines = text
		.replace(ANSI_ESCAPE, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("│") && line.endsWith("│"));
	const [headerLine, ...rowLines] = lines;
	if (headerLine === undefined) return [];
	if (rowLines.length > TABLE_ROWS_MAX)
		throw new CommandError(
			`Wrangler printed ${rowLines.length} rows, more than TABLE_ROWS_MAX (${TABLE_ROWS_MAX}).`
		);
	const header = cells(headerLine);
	return rowLines.map((line) => {
		const values = cells(line);
		if (values.length !== header.length)
			throw new CommandError(
				`Unexpected Wrangler table row (${values.length} cells, header has ${header.length}).`
			);
		return Object.fromEntries(
			header.map((name, index) => [name, values[index] ?? ""])
		);
	});
}

function cells(line: string): string[] {
	return line
		.slice(1, -1)
		.split("│")
		.map((cell) => cell.trim());
}

function tail(result: WranglerResult): string {
	return (result.stderr || result.stdout)
		.replace(ANSI_ESCAPE, "")
		.trim()
		.slice(-OUTPUT_TAIL_CHARS);
}

function failed(what: string, result: WranglerResult, help: string): Error {
	return new CommandError(
		`${what} failed (${result.status ?? "killed"}):\n${tail(result)}\n${help}`
	);
}

// --- Plain secrets on the live Worker ----------------------------------------

const workerSecretsSchema = z.array(
	z.looseObject({ name: z.string(), type: z.string() })
);

// Names of the live Worker's plain secrets; empty before the first deploy.
export function listWorkerPlainSecrets(
	args: { readonly workerName: string; readonly configPath: string },
	run: WranglerRunner
): readonly string[] {
	const result = run([
		"secret",
		"list",
		"--name",
		args.workerName,
		"--format",
		"json",
		"--config",
		args.configPath,
	]);
	if (result.status !== 0) {
		if (WORKER_NOT_FOUND.test(result.stderr + result.stdout)) return [];
		throw failed(
			`Listing ${args.workerName}'s Worker secrets`,
			result,
			"Deploy checks that the live Worker has no plain secrets before Void publishes."
		);
	}
	return workerSecretsSchema
		.parse(parseJson(result.stdout, "secret list"))
		.map((secret) => secret.name);
}

// The one-time switch for a Worker that already has plain secrets.
export function plainSecretsSwitchHelp(
	workerName: string,
	names: readonly string[]
): string {
	return [
		`${workerName} has plain Worker secrets: ${names.join(", ")}.`,
		PINNING_EXPLANATION,
		"Switch once, outside Void, with no sign-in outage. Commit and push void.lock.json (deploy recorded the store), then (each step is a dry run until --execute):",
		"  pnpm secrets:switch create-secrets   # each bound secret the store lacks",
		"  pnpm secrets:switch switch           # upload, check, then deploy the Store-based Worker",
		'Then rerun pnpm run deploy. See docs/DEPLOYMENT_GUIDE.md, "Switching a Worker that already has plain secrets".',
	].join("\n");
}

// --- The account's store -------------------------------------------------------

export type SecretsStore = {
	readonly storeId: string;
	readonly action: "reused" | "created";
};

const storeRowSchema = z.looseObject({
	Name: z.string().min(1),
	ID: z.string().regex(/^[0-9a-f]{32}$/),
});
const NO_STORES = /List request returned no stores/;
const CREATED_STORE = /Created store! \(Name: .+, ID: ([0-9a-f]{32})\)/;

function storeHelp(): string {
	return [
		"Deploy binds secrets from the account's Cloudflare Secrets Store. Create or find it with:",
		`  pnpm exec wrangler secrets-store store create ${DEFAULT_STORE_NAME} --remote`,
		"  pnpm exec wrangler secrets-store store list --remote",
		"then set store_id on the secrets_store_secrets bindings in config/cloudflare.mjs",
		"(SECRETS_STORE_ID_UNPROVISIONED) if deploy still cannot list it. The deploy token",
		"needs Secrets Store Write (Secrets Store Admin or Deployer role).",
	].join("\n");
}

// The account's stores, read-only; empty when it has none.
export function listSecretsStores(
	args: { readonly configPath: string },
	run: WranglerRunner
): readonly { readonly name: string; readonly id: string }[] {
	const listed = run([
		"secrets-store",
		"store",
		"list",
		"--per-page",
		String(LIST_PAGE_SIZE),
		"--remote",
		"--config",
		args.configPath,
	]);
	if (listed.status !== 0) {
		if (NO_STORES.test(tail(listed))) return [];
		throw failed("Listing Secrets Stores", listed, storeHelp());
	}
	const stores = z
		.array(storeRowSchema)
		.parse(parseWranglerTable(listed.stdout));
	if (stores.length === 0)
		throw new CommandError(
			`wrangler secrets-store store list printed no stores.\n${storeHelp()}`
		);
	return stores.map((store) => ({ name: store.Name, id: store.ID }));
}

// The account's only store, or a new one when it has none. Several stores
// mean the config must name one; deploy never guesses.
export function ensureSecretsStore(
	args: { readonly configPath: string },
	run: WranglerRunner
): SecretsStore {
	const stores = listSecretsStores(args, run);
	const [only] = stores;
	if (stores.length > 1)
		throw new CommandError(
			`The account has several Secrets Stores (${stores.map((store) => `${store.name} ${store.id}`).join(", ")}). Set store_id on the secrets_store_secrets bindings in config/cloudflare.mjs (replace SECRETS_STORE_ID_UNPROVISIONED) with the one to use, then rerun pnpm run deploy.`
		);
	if (only !== undefined) return { storeId: only.id, action: "reused" };
	const created = run([
		"secrets-store",
		"store",
		"create",
		DEFAULT_STORE_NAME,
		"--remote",
		"--config",
		args.configPath,
	]);
	const id = CREATED_STORE.exec(created.stdout.replace(ANSI_ESCAPE, ""))?.[1];
	if (created.status !== 0 || id === undefined)
		throw failed("Creating a Secrets Store", created, storeHelp());
	return { storeId: id, action: "created" };
}

const secretRowSchema = z.looseObject({
	Name: z.string().min(1),
	Scopes: z.string().optional(),
});
const NO_SECRETS = /List request returned no secrets/;

export type StoreSecret = {
	readonly name: string;
	// Services allowed to bind it; Workers need "workers".
	readonly scopes: readonly string[];
};

// Every secret in a store (names and scopes, never values), page by page.
export function listStoreSecrets(
	args: { readonly storeId: string; readonly configPath: string },
	run: WranglerRunner
): readonly StoreSecret[] {
	const secrets: StoreSecret[] = [];
	for (let page = 1; page <= LIST_PAGES_MAX; page++) {
		const result = run([
			"secrets-store",
			"secret",
			"list",
			args.storeId,
			"--page",
			String(page),
			"--per-page",
			String(LIST_PAGE_SIZE),
			"--remote",
			"--config",
			args.configPath,
		]);
		// Wrangler fails a page past the end (or an empty store) this way.
		if (result.status !== 0 && NO_SECRETS.test(tail(result)))
			return secrets;
		if (result.status !== 0)
			throw failed(
				`Listing the secrets in store ${args.storeId}`,
				result,
				storeHelp()
			);
		const rows = z
			.array(secretRowSchema)
			.parse(parseWranglerTable(result.stdout));
		for (const row of rows)
			secrets.push({
				name: row.Name,
				scopes: (row.Scopes ?? "")
					.split(",")
					.map((scope) => scope.trim())
					.filter((scope) => scope !== ""),
			});
		if (rows.length < LIST_PAGE_SIZE) return secrets;
	}
	throw new CommandError(
		`Store ${args.storeId} lists more than ${LIST_PAGES_MAX * LIST_PAGE_SIZE} secrets (LIST_PAGES_MAX).`
	);
}

// Every secret name in a store.
export function listStoreSecretNames(
	args: { readonly storeId: string; readonly configPath: string },
	run: WranglerRunner
): ReadonlySet<string> {
	return new Set(listStoreSecrets(args, run).map((secret) => secret.name));
}

// The commands that create each missing secret, or "" when none is missing.
export function missingSecretsHelp(
	storeId: string,
	missing: readonly {
		readonly binding: string;
		readonly secretName: string;
	}[]
): string {
	if (missing.length === 0) return "";
	return [
		`Secrets Store ${storeId} is missing ${missing.map((entry) => `${entry.secretName} (bound as ${entry.binding})`).join(", ")}.`,
		"Create each one (Wrangler prompts for the value; `pnpm secret` prints a random one):",
		...missing.map(
			(entry) => `  ${secretCreateCommand(storeId, entry.secretName)}`
		),
		"Or remove an optional secret from productionSecretNames in config/cloudflare.mjs. Then rerun pnpm run deploy.",
	].join("\n");
}

function parseJson(text: string, command: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new CommandError(
			`wrangler ${command} printed something other than JSON:\n${text.trim().slice(-OUTPUT_TAIL_CHARS)}`
		);
	}
}

// --- Local store -------------------------------------------------------------

// Writes secrets into the local Secrets Store under a persist directory, the
// one miniflare serves `secrets_store_secrets` bindings from. For fixture
// values only: Wrangler takes them as arguments.
export function seedLocalSecrets(
	args: {
		readonly persistTo: string;
		readonly storeId: string;
		readonly configPath: string;
		readonly secrets: Readonly<Record<string, string>>;
	},
	run: WranglerRunner
): void {
	for (const [name, value] of Object.entries(args.secrets)) {
		const result = run([
			"secrets-store",
			"secret",
			"create",
			args.storeId,
			"--name",
			name,
			"--value",
			value,
			"--scopes",
			"workers",
			"--persist-to",
			args.persistTo,
			"--config",
			args.configPath,
		]);
		if (result.status !== 0)
			throw failed(`Seeding the local secret ${name}`, result, "");
	}
}
