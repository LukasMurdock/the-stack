// The one place Worker code reads secrets. Production binds each secret from
// Cloudflare Secrets Store (`{ get(): Promise<string> }`); local development
// and tests pass plain strings. resolveSecrets reads every source once per
// request and returns validated strings, so the rest of the Worker never sees
// a binding object or an unvalidated value.
//
// Per request, not cached per isolate: a rotated value applies to the next
// request, no state outlives a request, and the cost is one Store read per
// declared secret (a fixed handful, read concurrently) on API requests only.

import {
	SECRET_NAMES,
	SECRET_VALUE_BYTES_MAX,
	type SecretName,
	workerSecrets,
} from "../contracts/secrets";

export type SecretSource = string | SecretsStoreSecret;

export type SecretSources = { readonly [Name in SecretName]?: SecretSource };

// Not readonly: it becomes part of the per-request env copy route code owns.
export type ResolvedSecrets = { [Name in SecretName]?: string };

export type SecretState =
	| { readonly kind: "present"; readonly value: string }
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "unreadable"; readonly reason: string };

export class MissingSecretError extends Error {
	constructor(name: SecretName) {
		super(
			`${name} is not configured. Production reads it from Cloudflare Secrets Store (docs/DEPLOYMENT_GUIDE.md, "Secrets"); locally, set it in .env.`
		);
		this.name = "MissingSecretError";
	}
}

// A value as the app accepts it. Whitespace-only counts as absent, so an
// emptied .env line behaves like a removed one.
export function parseSecretValue(name: SecretName, value: string): SecretState {
	const trimmed = value.trim();
	if (trimmed === "") return { kind: "absent" };
	if (new TextEncoder().encode(value).byteLength > SECRET_VALUE_BYTES_MAX)
		return {
			kind: "invalid",
			reason: `longer than ${SECRET_VALUE_BYTES_MAX} bytes`,
		};
	const { lengthMin } = workerSecrets[name];
	if (value.length < lengthMin)
		return {
			kind: "invalid",
			reason: `shorter than ${lengthMin} characters`,
		};
	return { kind: "present", value };
}

async function readSource(
	name: SecretName,
	source: SecretSource | undefined
): Promise<SecretState> {
	if (source === undefined) return { kind: "absent" };
	if (typeof source === "string") return parseSecretValue(name, source);
	let value: unknown;
	try {
		value = await source.get();
	} catch (error: unknown) {
		// A deleted Store secret and a failed read look the same here; either
		// way the secret is unavailable for this request.
		return {
			kind: "unreadable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	if (typeof value !== "string")
		return { kind: "invalid", reason: "the binding returned no string" };
	return parseSecretValue(name, value);
}

// Every declared secret's state. Never includes a value in a reason.
export async function readSecretStates(
	env: SecretSources
): Promise<ReadonlyMap<SecretName, SecretState>> {
	const states = await Promise.all(
		SECRET_NAMES.map(
			async (name) => [name, await readSource(name, env[name])] as const
		)
	);
	return new Map(states);
}

// Present values only. Invalid and unreadable secrets are reported (by name
// and reason, never value) and treated as absent; a required one then fails
// where it is used, through requireSecret.
export async function resolveSecrets(
	env: SecretSources
): Promise<ResolvedSecrets> {
	const resolved: ResolvedSecrets = {};
	for (const [name, state] of await readSecretStates(env)) {
		switch (state.kind) {
			case "present":
				resolved[name] = state.value;
				break;
			case "absent":
				break;
			case "invalid":
			case "unreadable":
				console.error({
					action: "secrets.unavailable",
					secret: name,
					requirement: workerSecrets[name].requirement,
					state: state.kind,
					reason: state.reason,
				});
				break;
			default:
				return assertNever(state);
		}
	}
	return resolved;
}

export function requireSecret(
	secrets: ResolvedSecrets,
	name: SecretName
): string {
	const value = secrets[name];
	if (value === undefined) throw new MissingSecretError(name);
	return value;
}

// Required secrets this request has no valid value for.
export function missingRequiredSecrets(
	secrets: ResolvedSecrets
): readonly SecretName[] {
	return SECRET_NAMES.filter(
		(name) =>
			workerSecrets[name].requirement === "required" &&
			secrets[name] === undefined
	);
}

// The Worker's environment with every secret source replaced by its value.
// Absent secrets are removed, so a Store binding never reaches route code.
export function withResolvedSecrets<Env extends SecretSources>(
	env: Env,
	secrets: ResolvedSecrets
): Omit<Env, SecretName> & ResolvedSecrets {
	const copy: Record<string, unknown> = { ...env };
	for (const name of SECRET_NAMES) delete copy[name];
	// SAFETY: copy is env without the secret names, which are then added back
	// as resolved strings; every other key keeps its original type.
	return { ...(copy as Omit<Env, SecretName>), ...secrets };
}

function assertNever(value: never): never {
	throw new Error(`Unexpected secret state: ${JSON.stringify(value)}`);
}
