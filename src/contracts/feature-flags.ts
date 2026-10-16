// The feature flag registry: every flag the code reads is declared here, with
// a safe default, an owner and an expiry date. Flags are temporary. Remove a
// flag and its dead branch once it is fully rolled out or expired; the unit
// test fails `verify` after `expires`. Values come from Cloudflare Flagship
// (the FLAGS binding); when it is missing or fails, the default is served.
// Dependency-free apart from zod: the Worker, the browser and scripts import it.

import { z } from "zod";

export const featureFlags = {
	// example:start
	"projects-total": booleanFlag({
		owner: "platform",
		description:
			"Shows the organization's project count on the Projects example page.",
		expires: "2027-04-16",
		exposure: "client",
		default: false,
	}),
	// example:end
} as const satisfies FlagRegistry;

export type FeatureFlags = typeof featureFlags;
export type FlagKey = keyof FeatureFlags & string;
export type FlagValueOf<Key extends FlagKey> = FlagValue<FeatureFlags[Key]>;
export type ClientFlagKey = {
	[Key in FlagKey]: FeatureFlags[Key]["exposure"] extends "client"
		? Key
		: never;
}[FlagKey];

// Flagship accepts 64 letters, digits, hyphens and underscores; the registry
// narrows that to lowercase kebab-case so a key reads the same everywhere.
export const FLAG_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FLAG_KEY_LENGTH_MAX = 64;
// Flagship's own limit on a flag description.
export const FLAG_DESCRIPTION_LENGTH_MAX = 512;
export const FLAG_OWNER_LENGTH_MAX = 64;
// GET /api/flags evaluates every client flag on each call, one binding call
// per flag, so the registry stays small. Flagship allows 5,000 per app.
export const FLAG_COUNT_MAX = 50;
// A flag is a temporary branch: it may not be declared to live longer than this.
export const FLAG_LIFETIME_DAYS_MAX = 366;
const DAY_MS = 86_400_000;
const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// "client": GET /api/flags returns it to the browser. "server": only Worker
// code reads it, so its key and value never leave the server.
export type FlagExposure = "client" | "server";

type FlagMetadata<Exposure extends FlagExposure> = {
	readonly owner: string;
	readonly description: string;
	// YYYY-MM-DD (UTC). The flag counts as expired from the start of that day.
	readonly expires: string;
	readonly exposure: Exposure;
};

export type BooleanFlag<Exposure extends FlagExposure = FlagExposure> =
	FlagMetadata<Exposure> & {
		readonly type: "boolean";
		readonly default: boolean;
		readonly schema: z.ZodType<boolean>;
	};
export type StringFlag<
	Value extends string = string,
	Exposure extends FlagExposure = FlagExposure,
> = FlagMetadata<Exposure> & {
	readonly type: "string";
	readonly default: Value;
	readonly schema: z.ZodType<Value>;
};
export type NumberFlag<Exposure extends FlagExposure = FlagExposure> =
	FlagMetadata<Exposure> & {
		readonly type: "number";
		readonly default: number;
		readonly schema: z.ZodType<number>;
	};
export type ObjectFlag<
	Value extends Record<string, unknown> = Record<string, unknown>,
	Exposure extends FlagExposure = FlagExposure,
> = FlagMetadata<Exposure> & {
	readonly type: "object";
	readonly default: Value;
	readonly schema: z.ZodType<Value>;
};
export type FlagDefinition = BooleanFlag | StringFlag | NumberFlag | ObjectFlag;
export type FlagRegistry = Readonly<Record<string, FlagDefinition>>;
export type FlagValue<Definition extends FlagDefinition> = z.output<
	Definition["schema"]
>;

export function booleanFlag<Exposure extends FlagExposure>(
	spec: FlagMetadata<Exposure> & { readonly default: boolean }
): BooleanFlag<Exposure> {
	return { ...spec, type: "boolean", schema: z.boolean() };
}

// The schema bounds what Flagship may serve, e.g. z.enum([...]) for variants.
export function stringFlag<Value extends string, Exposure extends FlagExposure>(
	spec: FlagMetadata<Exposure> & {
		readonly schema: z.ZodType<Value>;
		readonly default: NoInfer<Value>;
	}
): StringFlag<Value, Exposure> {
	return { ...spec, type: "string" };
}

export function numberFlag<Exposure extends FlagExposure>(
	spec: FlagMetadata<Exposure> & {
		readonly default: number;
		readonly schema?: z.ZodType<number>;
	}
): NumberFlag<Exposure> {
	return { ...spec, type: "number", schema: spec.schema ?? z.number() };
}

export function objectFlag<
	Value extends Record<string, unknown>,
	Exposure extends FlagExposure,
>(
	spec: FlagMetadata<Exposure> & {
		readonly schema: z.ZodType<Value>;
		readonly default: NoInfer<Value>;
	}
): ObjectFlag<Value, Exposure> {
	return { ...spec, type: "object" };
}

// The registry default of an app flag, typed by its key.
export function flagDefault<Key extends FlagKey>(key: Key): FlagValueOf<Key> {
	const registry: FlagRegistry = featureFlags;
	const definition = registry[key];
	if (definition === undefined)
		throw new Error(`Invariant violated: ${key} is not declared`);
	// SAFETY: a definition's default satisfies its own schema (the registry
	// test checks it), so it has that key's value type.
	return definition.default as FlagValueOf<Key>;
}

export function clientFlagKeys<Registry extends FlagRegistry>(
	registry: Registry
): (keyof Registry & string)[] {
	return Object.keys(registry).filter(
		(key) => registry[key]?.exposure === "client"
	);
}

type ClientFlagShape = {
	[Key in ClientFlagKey]: FeatureFlags[Key]["schema"];
};

function clientFlagShape(options: {
	readonly fallback: "none" | "default";
}): ClientFlagShape {
	// Widened, so this also compiles while no flag is declared.
	const registry: FlagRegistry = featureFlags;
	const shape: Record<string, z.ZodType> = {};
	for (const key of clientFlagKeys(registry)) {
		const definition = registry[key];
		if (definition === undefined) continue;
		const schema: z.ZodType = definition.schema;
		shape[key] =
			options.fallback === "default"
				? schema.catch(definition.default)
				: schema;
	}
	// SAFETY: the loop adds exactly the client keys, each with its own
	// definition's schema (catch keeps the output type).
	return shape as ClientFlagShape;
}

// GET /api/flags, as documented in OpenAPI.
export const flagsResponseSchema = z.object({
	flags: z.object(clientFlagShape({ fallback: "none" })),
});
// The browser's decoder: each value falls back to its default on its own, so
// one bad or missing value (an older Worker mid-deploy) keeps the others.
export const flagsClientSchema = z.object({
	flags: z.object(clientFlagShape({ fallback: "default" })),
});
export type FlagsResponse = z.infer<typeof flagsResponseSchema>;

export type FlagProblem = { readonly key: string; readonly problem: string };

// Problems with the registry as of `nowUnixMs`. Time is an input: the unit
// test passes the clock in, so an expired flag fails `verify` until removed.
export function flagRegistryProblems(
	registry: FlagRegistry,
	options: { readonly nowUnixMs: number }
): FlagProblem[] {
	const problems: FlagProblem[] = [];
	const keys = Object.keys(registry);
	if (keys.length > FLAG_COUNT_MAX)
		problems.push({
			key: "*",
			problem: `declares ${keys.length} flags; at most ${FLAG_COUNT_MAX} are allowed. Remove finished flags.`,
		});
	for (const key of keys) {
		const definition = registry[key];
		if (definition === undefined) continue;
		for (const problem of definitionProblems(key, definition, options))
			problems.push({ key, problem });
	}
	return problems;
}

function definitionProblems(
	key: string,
	definition: FlagDefinition,
	options: { readonly nowUnixMs: number }
): string[] {
	const problems: string[] = [];
	if (key.length > FLAG_KEY_LENGTH_MAX)
		problems.push(`key is longer than ${FLAG_KEY_LENGTH_MAX} characters`);
	if (!FLAG_KEY_PATTERN.test(key))
		problems.push("key must be lowercase kebab-case (a-z, 0-9, -)");
	problems.push(
		...textProblems("owner", definition.owner, FLAG_OWNER_LENGTH_MAX)
	);
	problems.push(
		...textProblems(
			"description",
			definition.description,
			FLAG_DESCRIPTION_LENGTH_MAX
		)
	);
	if (!definition.schema.safeParse(definition.default).success)
		problems.push("default does not match the flag's schema");
	if (typeof definition.default !== valueTypeOf(definition.type))
		problems.push(`default is not a ${definition.type}`);
	const expiresUnixMs = parseExpires(definition.expires);
	if (expiresUnixMs === undefined) {
		problems.push(
			`expires must be a YYYY-MM-DD date, got "${definition.expires}"`
		);
	} else if (expiresUnixMs <= options.nowUnixMs) {
		problems.push(
			`expired on ${definition.expires}: remove the flag and its dead branch, or extend expires with a reason`
		);
	} else if (
		expiresUnixMs - options.nowUnixMs >
		FLAG_LIFETIME_DAYS_MAX * DAY_MS
	) {
		problems.push(
			`expires more than ${FLAG_LIFETIME_DAYS_MAX} days from now; flags are temporary`
		);
	}
	return problems;
}

function textProblems(
	name: string,
	value: string,
	lengthMax: number
): string[] {
	if (value.trim() === "") return [`${name} is empty`];
	if (value.length > lengthMax)
		return [`${name} is longer than ${lengthMax} characters`];
	return [];
}

function valueTypeOf(type: FlagDefinition["type"]): string {
	switch (type) {
		case "boolean":
			return "boolean";
		case "string":
			return "string";
		case "number":
			return "number";
		case "object":
			return "object";
	}
}

// Start of the day in UTC, or undefined for anything but a real date: Date
// would roll "2027-02-30" over to March.
export function parseExpires(expires: string): number | undefined {
	if (!EXPIRES_PATTERN.test(expires)) return undefined;
	const unixMs = Date.parse(`${expires}T00:00:00Z`);
	if (Number.isNaN(unixMs)) return undefined;
	if (new Date(unixMs).toISOString().slice(0, 10) !== expires)
		return undefined;
	return unixMs;
}
