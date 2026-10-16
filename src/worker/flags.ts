// Server-side flag evaluation. A request evaluates the flags it needs once,
// up front, and passes the values down (Flagship's "evaluate once per
// request"). Every failure serves the registry default, never an error.

import {
	featureFlags,
	type FlagDefinition,
	type FlagKey,
	type FlagRegistry,
	type FlagValue,
} from "../contracts/feature-flags";
import { normalizeAccountRole } from "../features/auth/policy";
import { recordFlagFallbacks, type FlagFallback } from "./observability/evlog";

// Flagship matches condition values of up to 256 characters. Our IDs are far
// shorter; anything longer is not an ID we issued.
export const FLAG_CONTEXT_VALUE_LENGTH_MAX = 128;
// Enough of an unexpected binding error to identify it in the request log.
const ERROR_DETAIL_LENGTH_MAX = 200;

// The binding methods this module uses; tests supply a typed fake.
export type FlagBinding = Pick<
	Flagship,
	| "getBooleanDetails"
	| "getStringDetails"
	| "getNumberDetails"
	| "getObjectDetails"
>;

// Who is asking. Only stable IDs and the account role reach Flagship: never
// email, name, IP address or tokens.
export type FlagSubject = {
	readonly userId: string;
	readonly role: unknown;
	readonly organizationId?: string | undefined;
};

// Why the default was served: a Flagship error code (FLAG_NOT_FOUND,
// TYPE_MISMATCH, ...) or one of ours.
export type FlagFallbackCause =
	| "BINDING_MISSING"
	| "BINDING_ERROR"
	| "SCHEMA_MISMATCH"
	| (string & {});

export type FlagEvaluation<Value> =
	| {
			readonly source: "flagship";
			readonly value: Value;
			readonly reason: string;
	  }
	| {
			readonly source: "default";
			readonly value: Value;
			readonly cause: FlagFallbackCause;
			readonly detail?: string;
	  };

export type FlagEvaluations<
	Registry extends FlagRegistry,
	Key extends keyof Registry,
> = { readonly [K in Key]: FlagEvaluation<FlagValue<Registry[K]>> };

export type FlagValues<Key extends FlagKey> = {
	readonly [K in Key]: FlagValue<(typeof featureFlags)[K]>;
};

// The evaluation context: bounded, and only what targeting rules use. A value
// over the bound is left out rather than truncated, since a truncated ID could
// match someone else's rule.
export function flagEvaluationContext(
	subject: FlagSubject
): FlagshipEvaluationContext {
	const context: Record<string, string> = {
		role: normalizeAccountRole(subject.role),
	};
	if (withinContextBound(subject.userId)) context.userId = subject.userId;
	if (
		subject.organizationId !== undefined &&
		withinContextBound(subject.organizationId)
	)
		context.organizationId = subject.organizationId;
	return context;
}

function withinContextBound(value: string): boolean {
	if (value === "") return false;
	return value.length <= FLAG_CONTEXT_VALUE_LENGTH_MAX;
}

// Evaluates `keys` from any registry: the app passes `featureFlags`, tests
// pass their own. Concurrency is bounded by the registry's FLAG_COUNT_MAX.
export async function evaluateFlags<
	Registry extends FlagRegistry,
	Key extends keyof Registry & string,
>(args: {
	readonly registry: Registry;
	readonly binding: FlagBinding | undefined;
	readonly context: FlagshipEvaluationContext;
	readonly keys: readonly Key[];
}): Promise<FlagEvaluations<Registry, Key>> {
	const entries = await Promise.all(
		args.keys.map(async (key) => {
			const definition: FlagDefinition | undefined = args.registry[key];
			if (definition === undefined)
				throw new Error(`Invariant violated: ${key} is not declared`);
			const evaluation = await evaluateFlag(
				key,
				definition,
				args.binding,
				args.context
			);
			return [key, evaluation] as const;
		})
	);
	// SAFETY: one entry per requested key, each evaluated against that key's
	// own definition, so its value has that definition's schema output.
	return Object.fromEntries(entries) as FlagEvaluations<Registry, Key>;
}

// The app's flags for one request, as plain values. Fallbacks caused by
// misconfiguration are logged once for the request.
export async function requestFlags<Key extends FlagKey>(args: {
	readonly binding: FlagBinding | undefined;
	readonly subject: FlagSubject;
	readonly keys: readonly Key[];
}): Promise<FlagValues<Key>> {
	const evaluations = await evaluateFlags({
		registry: featureFlags,
		binding: args.binding,
		context: flagEvaluationContext(args.subject),
		keys: args.keys,
	});
	recordFlagFallbacks(misconfiguredFlags(evaluations));
	const values: Record<string, unknown> = {};
	for (const key of args.keys) values[key] = evaluations[key].value;
	// SAFETY: each value is copied from its own key's evaluation.
	return values as FlagValues<Key>;
}

// A missing binding (readiness reports it) and a flag not yet created in
// Flagship are expected states; everything else means something is wrong.
function misconfiguredFlags(
	evaluations: Readonly<Record<string, FlagEvaluation<unknown>>>
): FlagFallback[] {
	const fallbacks: FlagFallback[] = [];
	for (const [key, evaluation] of Object.entries(evaluations)) {
		if (evaluation.source === "flagship") continue;
		if (evaluation.cause === "BINDING_MISSING") continue;
		if (evaluation.cause === "FLAG_NOT_FOUND") continue;
		fallbacks.push({
			key,
			cause: evaluation.cause,
			...(evaluation.detail === undefined
				? {}
				: { detail: evaluation.detail }),
		});
	}
	return fallbacks;
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, ERROR_DETAIL_LENGTH_MAX);
}

async function evaluateFlag(
	key: string,
	definition: FlagDefinition,
	binding: FlagBinding | undefined,
	context: FlagshipEvaluationContext
): Promise<FlagEvaluation<unknown>> {
	if (binding === undefined)
		return {
			source: "default",
			value: definition.default,
			cause: "BINDING_MISSING",
		};
	let details: FlagshipEvaluationDetails<unknown>;
	try {
		details = await flagDetails(key, definition, binding, context);
	} catch (error: unknown) {
		// The binding returns the default for known failures but can still
		// throw for unexpected ones; a flag must never fail the request.
		return {
			source: "default",
			value: definition.default,
			cause: "BINDING_ERROR",
			detail: boundedMessage(error),
		};
	}
	if (details.errorCode !== undefined)
		return {
			source: "default",
			value: definition.default,
			cause: details.errorCode,
		};
	// Flagship checks the primitive type; the schema also bounds the value
	// (an enum of variants, an object's shape).
	const parsed = definition.schema.safeParse(details.value);
	if (!parsed.success)
		return {
			source: "default",
			value: definition.default,
			cause: "SCHEMA_MISMATCH",
		};
	return {
		source: "flagship",
		value: parsed.data,
		reason: details.reason ?? "UNKNOWN",
	};
}

function flagDetails(
	key: string,
	definition: FlagDefinition,
	binding: FlagBinding,
	context: FlagshipEvaluationContext
): Promise<FlagshipEvaluationDetails<unknown>> {
	switch (definition.type) {
		case "boolean":
			return binding.getBooleanDetails(key, definition.default, context);
		case "string":
			return binding.getStringDetails(key, definition.default, context);
		case "number":
			return binding.getNumberDetails(key, definition.default, context);
		case "object":
			return binding.getObjectDetails(key, definition.default, context);
	}
}

// For /api/readiness and the doctor: without the binding every flag serves
// its registry default.
export function flagBindingStatus(binding: FlagBinding | undefined) {
	if (binding === undefined)
		return { binding: "missing", serving: "defaults" } as const;
	return { binding: "configured" } as const;
}
