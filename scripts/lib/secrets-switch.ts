// Pure decisions and Wrangler output parsers for the one-time switch of a
// live Worker from plain secrets to Cloudflare Secrets Store
// (scripts/secrets-switch.ts), kept apart from processes and the network so
// tooling tests drive them directly.

import { z } from "zod";
import { isSecretName, workerSecrets } from "../../src/contracts/secrets.ts";
import { CommandError } from "./cli.ts";
import { PLAIN_SECRET_TYPES, type StoreSecret } from "./secrets-store.ts";

// A Secrets Store binding's type in Cloudflare's Workers API.
export const STORE_BINDING_TYPE = "secrets_store_secret";
// The scope a store secret needs before a Worker may bind it.
export const WORKERS_SCOPE = "workers";
// The longest Wrangler output kept in an error message.
const OUTPUT_TAIL_CHARS = 2_000;

export type StoreEntry = {
	readonly binding: string;
	readonly store_id: string;
	readonly secret_name: string;
};

const bindingSchema = z.looseObject({
	name: z.string().min(1),
	type: z.string().min(1),
	store_id: z.string().optional(),
	secret_name: z.string().optional(),
});
export type LiveBinding = z.infer<typeof bindingSchema>;

// --- Wrangler output ---------------------------------------------------------

// The JSON object in a `--json` command's stdout; some commands print a line
// or two around it.
function jsonObject(output: string, command: string): unknown {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start === -1 || end < start)
		throw new CommandError(
			`wrangler ${command} printed no JSON:\n${output.trim().slice(-OUTPUT_TAIL_CHARS)}`
		);
	try {
		return JSON.parse(output.slice(start, end + 1));
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new CommandError(
			`wrangler ${command} printed malformed JSON:\n${output.trim().slice(-OUTPUT_TAIL_CHARS)}`
		);
	}
}

const whoamiSchema = z.looseObject({ loggedIn: z.boolean() });

// `wrangler whoami --json` -> whether Wrangler has credentials.
export function parseLoggedIn(output: string): boolean {
	return whoamiSchema.parse(jsonObject(output, "whoami")).loggedIn;
}

const deploymentSchema = z.looseObject({
	versions: z.array(
		z.looseObject({
			version_id: z.string().min(1),
			percentage: z.number(),
		})
	),
});

// `wrangler deployments status --json` -> the version serving 100% of
// traffic, or null while traffic is split between versions.
export function activeVersion(output: string): string | null {
	const { versions } = deploymentSchema.parse(
		jsonObject(output, "deployments status")
	);
	const [only] = versions;
	if (versions.length !== 1 || only === undefined) return null;
	return only.percentage === 100 ? only.version_id : null;
}

const versionSchema = z.looseObject({
	id: z.string().min(1),
	resources: z.looseObject({ bindings: z.array(bindingSchema) }),
});

// `wrangler versions view <id> --json` -> that version's bindings.
export function parseVersionBindings(output: string): readonly LiveBinding[] {
	return versionSchema.parse(jsonObject(output, "versions view")).resources
		.bindings;
}

const bookmarkSchema = z.looseObject({ bookmark: z.string().min(1) });

// `wrangler d1 time-travel info <db> --json` -> the current bookmark.
export function parseBookmark(output: string): string {
	return bookmarkSchema.parse(jsonObject(output, "d1 time-travel info"))
		.bookmark;
}

// Wrangler prints the uploaded version this way (`versions upload`).
const UPLOADED_VERSION = /Worker Version ID:\s*([0-9a-f-]{36})/i;
const PREVIEW_URL = /Version Preview URL:\s*(https:\/\/\S+)/;

export function uploadedVersionId(output: string): string | null {
	return UPLOADED_VERSION.exec(output)?.[1] ?? null;
}

// The version's own URL; absent when preview_urls is off.
export function uploadedPreviewUrl(output: string): string | null {
	const url = PREVIEW_URL.exec(output)?.[1];
	return url === undefined ? null : new URL(url).origin;
}

// Cloudflare's refusal of a binding whose name another binding of the version
// already uses ("Binding name 'X' already in use", code 10053). Wrangler keeps
// the live plain secrets on every upload, so a Store binding named like one
// of them could be refused this way. Cloudflare accepted it when a product
// fork switched (2026-10); the fallback stays for an account that does not.
export function isBindingNameConflict(output: string): boolean {
	return /already in use|\[code: 10053\]/i.test(output);
}

// --- Verdicts ----------------------------------------------------------------

export type BindingsVerdict =
	| { readonly kind: "store" }
	| { readonly kind: "not-store"; readonly problems: readonly string[] };

// Whether a version binds every configured secret from the Store under the
// configured store and name (and none as a plain secret). Only such a
// version may take traffic.
export function storeBindingsVerdict(
	entries: readonly StoreEntry[],
	bindings: readonly LiveBinding[]
): BindingsVerdict {
	const byName = new Map(bindings.map((binding) => [binding.name, binding]));
	const problems: string[] = [];
	for (const entry of entries) {
		const binding = byName.get(entry.binding);
		if (binding === undefined)
			problems.push(`${entry.binding} is not bound`);
		else if (PLAIN_SECRET_TYPES.includes(binding.type))
			problems.push(
				`${entry.binding} is still a plain secret (${binding.type})`
			);
		else if (binding.type !== STORE_BINDING_TYPE)
			problems.push(`${entry.binding} is a ${binding.type} binding`);
		else if (
			binding.store_id !== entry.store_id ||
			binding.secret_name !== entry.secret_name
		)
			problems.push(
				`${entry.binding} binds ${binding.store_id ?? "?"}/${binding.secret_name ?? "?"}, not ${entry.store_id}/${entry.secret_name}`
			);
	}
	if (problems.length === 0) return { kind: "store" };
	return { kind: "not-store", problems };
}

// Names of a version's plain secrets, sorted.
export function plainSecretNames(
	bindings: readonly LiveBinding[]
): readonly string[] {
	return bindings
		.filter((binding) => PLAIN_SECRET_TYPES.includes(binding.type))
		.map((binding) => binding.name)
		.sort();
}

// Bound secrets the store lacks, and those it has without the workers scope.
export function unusableSecrets(
	entries: readonly StoreEntry[],
	listed: readonly StoreSecret[]
): {
	readonly missing: readonly StoreEntry[];
	readonly unscoped: readonly StoreEntry[];
} {
	const byName = new Map(listed.map((secret) => [secret.name, secret]));
	const missing: StoreEntry[] = [];
	const unscoped: StoreEntry[] = [];
	for (const entry of entries) {
		const secret = byName.get(entry.secret_name);
		if (secret === undefined) missing.push(entry);
		else if (!secret.scopes.includes(WORKERS_SCOPE)) unscoped.push(entry);
	}
	return { missing, unscoped };
}

// Missing secrets the switch may create with a random value (the app mints
// them), and provider-issued ones (an API key) the operator must supply.
export function splitByValueSource(missing: readonly StoreEntry[]): {
	readonly generated: readonly StoreEntry[];
	readonly provided: readonly StoreEntry[];
} {
	const generated: StoreEntry[] = [];
	const provided: StoreEntry[] = [];
	for (const entry of missing) {
		if (
			isSecretName(entry.binding) &&
			workerSecrets[entry.binding].generated
		)
			generated.push(entry);
		else provided.push(entry);
	}
	return { generated, provided };
}

// The bridge: the same build without its Store bindings, so Wrangler uploads
// it beside the live plain secrets (which it keeps) with no name conflict.
// The Worker resolves plain strings and Store bindings alike
// (src/worker/secrets.ts).
export function bridgeConfig(
	wranglerJson: Readonly<Record<string, unknown>>
): Record<string, unknown> {
	return { ...wranglerJson, secrets_store_secrets: [] };
}

// `wrangler secret bulk` input deleting every named plain secret in one
// request, so a single new version drops them all.
export function deletionPayload(names: readonly string[]): string {
	return JSON.stringify(
		Object.fromEntries(names.map((name) => [name, null]))
	);
}

export type Preflight = {
	readonly cleanMain: boolean;
	readonly storeRecorded: boolean;
	// Bound secrets the store lacks or has without the workers scope.
	readonly unusableSecrets: readonly string[];
	// Live plain secrets the config does not bind from the Store: dropping
	// them would lose a value nothing else holds.
	readonly unboundPlain: readonly string[];
	readonly activeVersion: string | null;
	readonly expectedVersion: string | null;
};

// Everything that must hold before the switch writes anything; empty means
// it may proceed.
export function preflightProblems(preflight: Preflight): readonly string[] {
	const problems: string[] = [];
	if (!preflight.cleanMain)
		problems.push(
			"Run from a clean main at origin/main: production is built from what is pushed."
		);
	if (!preflight.storeRecorded)
		problems.push(
			"void.lock.json records no Secrets Store; run `pnpm secrets:switch store --execute` and commit void.lock.json first."
		);
	if (preflight.unusableSecrets.length > 0)
		problems.push(
			`The store lacks (or lacks the workers scope on) ${preflight.unusableSecrets.join(", ")}; run \`pnpm secrets:switch create-secrets\` first.`
		);
	if (preflight.unboundPlain.length > 0)
		problems.push(
			`The live Worker has plain secrets the config does not bind from the Store: ${preflight.unboundPlain.join(", ")}. Add them to productionSecretNames and the store (or confirm they are unused and delete them) first.`
		);
	if (preflight.activeVersion === null)
		problems.push(
			"The live Worker is not one version at 100% (a gradual rollout?); finish it first."
		);
	else if (
		preflight.expectedVersion !== null &&
		!preflight.activeVersion.startsWith(preflight.expectedVersion)
	)
		problems.push(
			`The live Worker serves ${preflight.activeVersion}, not ${preflight.expectedVersion} (--expect-version).`
		);
	return problems;
}

// --- Anonymous probes --------------------------------------------------------

// A response body that is not JSON (an HTML error page mid-rollout) parses
// to null; the schema check then reports it.
function jsonOrNull(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		return null;
	}
}

const readinessSchema = z.looseObject({
	secrets: z.looseObject({ missingRequired: z.array(z.string()) }),
});

// A /api/readiness response -> why it does not prove every required secret
// resolved, or null when it does.
export function readinessProblem(status: number, body: string): string | null {
	const parsed = readinessSchema.safeParse(jsonOrNull(body));
	if (!parsed.success)
		return `/api/readiness answered ${status} without secrets.missingRequired`;
	const missing = parsed.data.secrets.missingRequired;
	if (status !== 200 || missing.length > 0)
		return `/api/readiness answered ${status}, secrets.missingRequired ${JSON.stringify(missing)}`;
	return null;
}

const turretHealthSchema = z.looseObject({
	turret: z.looseObject({
		configuredMode: z.string(),
		effectiveMode: z.string(),
	}),
});

// Turret runs in full mode only with its signing key, so a Worker configured
// for full mode that reports anything else did not resolve TURRET_SIGNING_KEY.
export function turretProblem(healthBody: string): string | null {
	const parsed = turretHealthSchema.safeParse(jsonOrNull(healthBody));
	if (!parsed.success) return "/api/health reports no turret mode";
	const { configuredMode, effectiveMode } = parsed.data.turret;
	if (configuredMode === "full" && effectiveMode !== "full")
		return `Turret is configured full but runs ${effectiveMode}: TURRET_SIGNING_KEY did not resolve`;
	return null;
}
