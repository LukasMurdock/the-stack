import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
	booleanFlag,
	clientFlagKeys,
	featureFlags,
	flagsResponseSchema,
	numberFlag,
	objectFlag,
	stringFlag,
	type FlagRegistry,
} from "../../src/contracts/feature-flags";
import { productErrorSchema } from "../../src/contracts/operation";
import { createOrganization } from "../../src/features/organizations/operations";
import {
	evaluateFlags,
	FLAG_CONTEXT_VALUE_LENGTH_MAX,
	flagEvaluationContext,
} from "../../src/worker/flags";
import { signedInApi } from "../helpers/product-http";

// What the fake binding does for one key: serve a value the way Flagship
// would, report a Flagship error code with the default, or throw.
type Behavior =
	| {
			readonly kind: "serve";
			readonly value: unknown;
			readonly reason: string;
	  }
	| { readonly kind: "error"; readonly errorCode: string }
	| { readonly kind: "throw"; readonly message: string };

// A typed stand-in for env.FLAGS. Unlisted keys behave as Flagship does for
// a flag the app lacks. Every context it receives is recorded.
function fakeFlagship(behaviors: Readonly<Record<string, Behavior>>) {
	const contexts: FlagshipEvaluationContext[] = [];
	async function details<T>(
		flagKey: string,
		defaultValue: T,
		context: FlagshipEvaluationContext = {}
	): Promise<FlagshipEvaluationDetails<T>> {
		contexts.push(context);
		const behavior = behaviors[flagKey] ?? {
			kind: "error",
			errorCode: "FLAG_NOT_FOUND",
		};
		if (behavior.kind === "throw") throw new Error(behavior.message);
		if (behavior.kind === "error")
			return {
				flagKey,
				value: defaultValue,
				reason: "ERROR",
				errorCode: behavior.errorCode,
			};
		// SAFETY: deliberately unchecked; the fake can serve a mistyped value
		// the way a misconfigured flag would, which the code under test must catch.
		return { flagKey, value: behavior.value as T, reason: behavior.reason };
	}
	async function value<T>(
		flagKey: string,
		defaultValue: T,
		context?: FlagshipEvaluationContext
	): Promise<T> {
		return (await details(flagKey, defaultValue, context)).value;
	}
	// The app uses only the typed methods; the inferring ones must not be reached.
	const unused = () => Promise.reject(new Error("not used by the app"));
	const binding: Flagship = {
		get: unused,
		getValue: unused,
		getDetails: unused,
		getBooleanValue: value,
		getStringValue: value,
		getNumberValue: value,
		getObjectValue: value,
		getBooleanDetails: details,
		getStringDetails: details,
		getNumberDetails: details,
		getObjectDetails: details,
	};
	return { binding, contexts };
}

const metadata = {
	owner: "platform",
	description: "A test flag.",
	expires: "2027-01-01",
	exposure: "client",
} as const;
const registry = {
	"new-checkout": booleanFlag({ ...metadata, default: false }),
	"checkout-flow": stringFlag({
		...metadata,
		schema: z.enum(["v1", "v2"]),
		default: "v1",
	}),
	"upload-limit": numberFlag({
		...metadata,
		schema: z.number().int().min(1).max(100),
		default: 10,
	}),
	theme: objectFlag({
		...metadata,
		schema: z.object({ accent: z.enum(["blue", "green"]) }),
		default: { accent: "blue" },
	}),
} satisfies FlagRegistry;
const keys = [
	"new-checkout",
	"checkout-flow",
	"upload-limit",
	"theme",
] as const;
const context = flagEvaluationContext({ userId: "user-1", role: "user" });

test("served values pass through with Flagship's reason", async () => {
	const { binding, contexts } = fakeFlagship({
		"new-checkout": {
			kind: "serve",
			value: true,
			reason: "TARGETING_MATCH",
		},
		"checkout-flow": { kind: "serve", value: "v2", reason: "SPLIT" },
		"upload-limit": { kind: "serve", value: 50, reason: "STATIC" },
		theme: { kind: "serve", value: { accent: "green" }, reason: "DEFAULT" },
	});
	const flags = await evaluateFlags({ registry, binding, context, keys });
	assert.deepEqual(flags, {
		"new-checkout": {
			source: "flagship",
			value: true,
			reason: "TARGETING_MATCH",
		},
		"checkout-flow": { source: "flagship", value: "v2", reason: "SPLIT" },
		"upload-limit": { source: "flagship", value: 50, reason: "STATIC" },
		theme: {
			source: "flagship",
			value: { accent: "green" },
			reason: "DEFAULT",
		},
	});
	assert.equal(contexts.length, keys.length, "one evaluation per flag");
	for (const received of contexts) assert.deepEqual(received, context);
});

test("a throw, a missing flag, a type mismatch or an out-of-schema value serve the default", async () => {
	const { binding } = fakeFlagship({
		"new-checkout": {
			kind: "throw",
			message: `timeout ${"x".repeat(500)}`,
		},
		"checkout-flow": { kind: "error", errorCode: "TYPE_MISMATCH" },
		// Flagship checked the primitive type; the schema bounds the value.
		"upload-limit": { kind: "serve", value: 5000, reason: "STATIC" },
		theme: { kind: "serve", value: { accent: "red" }, reason: "STATIC" },
	});
	const flags = await evaluateFlags({ registry, binding, context, keys });
	const thrown = flags["new-checkout"];
	assert.equal(thrown.source, "default");
	assert.equal(thrown.value, false);
	assert.ok(thrown.source === "default" && thrown.cause === "BINDING_ERROR");
	assert.ok((thrown.detail ?? "").length <= 200, "error detail is bounded");
	assert.deepEqual(flags["checkout-flow"], {
		source: "default",
		value: "v1",
		cause: "TYPE_MISMATCH",
	});
	assert.deepEqual(flags["upload-limit"], {
		source: "default",
		value: 10,
		cause: "SCHEMA_MISMATCH",
	});
	assert.deepEqual(flags.theme, {
		source: "default",
		value: { accent: "blue" },
		cause: "SCHEMA_MISMATCH",
	});
	const missing = await evaluateFlags({
		registry,
		binding: fakeFlagship({}).binding,
		context,
		keys: ["checkout-flow"],
	});
	assert.deepEqual(missing["checkout-flow"], {
		source: "default",
		value: "v1",
		cause: "FLAG_NOT_FOUND",
	});
	const unbound = await evaluateFlags({
		registry,
		binding: undefined,
		context,
		keys,
	});
	for (const key of keys)
		assert.deepEqual(unbound[key], {
			source: "default",
			value: registry[key].default,
			cause: "BINDING_MISSING",
		});
});

test("the evaluation context holds bounded IDs and the account role, nothing else", () => {
	const longest = "u".repeat(FLAG_CONTEXT_VALUE_LENGTH_MAX);
	assert.deepEqual(
		flagEvaluationContext({
			userId: longest,
			role: "admin,user",
			organizationId: "org-1",
		}),
		{ role: "admin", userId: longest, organizationId: "org-1" }
	);
	// Over the bound, an ID is dropped rather than truncated: a truncated ID
	// could match a rule written for someone else.
	assert.deepEqual(
		flagEvaluationContext({
			userId: `${longest}u`,
			role: "support",
			organizationId: "",
		}),
		{ role: "other" }
	);
	assert.deepEqual(flagEvaluationContext({ userId: "u", role: undefined }), {
		role: "user",
		userId: "u",
	});
});

test("GET /api/flags requires a session and an organization the user belongs to", async (t) => {
	const { f, env, request } = await signedInApi();
	t.after(() => f.sqlite.close());
	const anonymous = await request("/flags", "GET", undefined, "");
	assert.equal(anonymous.status, 401);
	assert.equal(
		productErrorSchema.parse(await anonymous.json()).error.code,
		"unauthorized"
	);
	assert.equal(anonymous.headers.get("cache-control"), "no-store");

	// Without the binding, every client flag is served at its default.
	const unbound = await request("/flags");
	assert.equal(unbound.status, 200);
	// Widened, so the test also compiles while no flag is declared.
	const declared: FlagRegistry = featureFlags;
	const defaults = Object.fromEntries(
		clientFlagKeys(declared).map((key) => [key, declared[key]?.default])
	);
	assert.deepEqual(flagsResponseSchema.parse(await unbound.json()), {
		flags: defaults,
	});

	const { binding, contexts } = fakeFlagship({});
	env.FLAGS = binding;
	const own = await createOrganization(f.actor("owner"), { name: "Own" });
	const member = await request(`/flags?organizationId=${own.id}`);
	assert.equal(member.status, 200);
	for (const received of contexts)
		assert.deepEqual(received, {
			role: "user",
			userId: "owner",
			organizationId: own.id,
		});
	const other = await createOrganization(f.actor("outsider"), {
		name: "Other",
	});
	const outsider = await request(`/flags?organizationId=${other.id}`);
	assert.equal(outsider.status, 404);
	const malformed = await request("/flags?organizationId=not-an-id");
	assert.equal(malformed.status, 400);
});
