import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
	booleanFlag,
	featureFlags,
	FLAG_COUNT_MAX,
	FLAG_DESCRIPTION_LENGTH_MAX,
	FLAG_KEY_LENGTH_MAX,
	FLAG_LIFETIME_DAYS_MAX,
	clientFlagKeys,
	flagDefault,
	flagsClientSchema,
	flagRegistryProblems,
	type FlagRegistry,
	numberFlag,
	objectFlag,
	parseExpires,
	stringFlag,
} from "../../src/contracts/feature-flags";

const DAY_MS = 86_400_000;
const NOW_UNIX_MS = Date.parse("2026-10-16T12:00:00Z");
const metadata = {
	owner: "platform",
	description: "A test flag.",
	expires: "2027-01-01",
	exposure: "client",
} as const;

function problemsOf(registry: FlagRegistry, nowUnixMs = NOW_UNIX_MS) {
	return flagRegistryProblems(registry, { nowUnixMs }).map(
		({ key, problem }) => `${key}: ${problem}`
	);
}

// The clock is read here, at the test boundary, and nowhere in the registry:
// a flag past its expiry date fails `verify` until it is removed or extended.
test("every declared flag is valid and unexpired today", () => {
	assert.deepEqual(
		flagRegistryProblems(featureFlags, { nowUnixMs: Date.now() }),
		[]
	);
});

test("valid definitions of each type pass, at the edges of their bounds", () => {
	const registry = {
		[`ab${"-b".repeat((FLAG_KEY_LENGTH_MAX - 2) / 2)}`]: booleanFlag({
			...metadata,
			default: false,
		}),
		"checkout-flow": stringFlag({
			...metadata,
			description: "d".repeat(FLAG_DESCRIPTION_LENGTH_MAX),
			schema: z.enum(["v1", "v2"]),
			default: "v1",
		}),
		"upload-limit": numberFlag({
			...metadata,
			exposure: "server",
			default: 10,
		}),
		"theme-config": objectFlag({
			...metadata,
			schema: z.object({ accent: z.string() }),
			default: { accent: "blue" },
		}),
	} satisfies FlagRegistry;
	assert.equal(Object.keys(registry)[0]?.length, FLAG_KEY_LENGTH_MAX);
	assert.deepEqual(problemsOf(registry), []);
	assert.deepEqual(problemsOf({}), [], "an empty registry is valid");
});

test("expiry: expired from the start of its day, and never too far out", () => {
	const flag = (expires: string) => ({
		flag: booleanFlag({ ...metadata, expires, default: false }),
	});
	const expiresUnixMs = Date.parse("2027-01-01T00:00:00Z");
	assert.deepEqual(problemsOf(flag("2027-01-01"), expiresUnixMs - 1), []);
	assert.deepEqual(problemsOf(flag("2027-01-01"), expiresUnixMs), [
		"flag: expired on 2027-01-01: remove the flag and its dead branch, or extend expires with a reason",
	]);
	const lifetimeMs = FLAG_LIFETIME_DAYS_MAX * DAY_MS;
	assert.deepEqual(
		problemsOf(flag("2027-01-01"), expiresUnixMs - lifetimeMs),
		[]
	);
	assert.deepEqual(
		problemsOf(flag("2027-01-01"), expiresUnixMs - lifetimeMs - 1),
		[
			`flag: expires more than ${FLAG_LIFETIME_DAYS_MAX} days from now; flags are temporary`,
		]
	);
	for (const expires of ["2027-02-30", "2027-1-01", "next week", ""])
		assert.deepEqual(problemsOf(flag(expires)), [
			`flag: expires must be a YYYY-MM-DD date, got "${expires}"`,
		]);
	assert.equal(
		parseExpires("2028-02-29"),
		Date.parse("2028-02-29T00:00:00Z")
	);
	assert.equal(parseExpires("2027-02-29"), undefined);
});

test("keys, owners, descriptions, defaults and the flag count are validated", () => {
	const valid = booleanFlag({ ...metadata, default: false });
	for (const key of [
		"Uppercase",
		"snake_case",
		"-leading",
		"trailing-",
		"double--hyphen",
		"",
	])
		assert.deepEqual(problemsOf({ [key]: valid }), [
			`${key}: key must be lowercase kebab-case (a-z, 0-9, -)`,
		]);
	assert.deepEqual(
		problemsOf({ ["a".repeat(FLAG_KEY_LENGTH_MAX + 1)]: valid }),
		[
			`${"a".repeat(FLAG_KEY_LENGTH_MAX + 1)}: key is longer than ${FLAG_KEY_LENGTH_MAX} characters`,
		]
	);
	assert.deepEqual(
		problemsOf({
			flag: {
				...valid,
				owner: " ",
				description: "d".repeat(FLAG_DESCRIPTION_LENGTH_MAX + 1),
			},
		}),
		[
			"flag: owner is empty",
			`flag: description is longer than ${FLAG_DESCRIPTION_LENGTH_MAX} characters`,
		]
	);
	// Only reachable by bypassing the helpers' types, e.g. from JavaScript.
	const variant = stringFlag({
		...metadata,
		schema: z.enum(["v1", "v2"]),
		default: "v1",
	});
	assert.deepEqual(problemsOf({ flag: { ...variant, default: "v3" } }), [
		"flag: default does not match the flag's schema",
	]);
	const tooMany = Object.fromEntries(
		Array.from({ length: FLAG_COUNT_MAX + 1 }, (_, index) => [
			`flag-${index}`,
			valid,
		])
	);
	assert.deepEqual(problemsOf(tooMany), [
		`*: declares ${FLAG_COUNT_MAX + 1} flags; at most ${FLAG_COUNT_MAX} are allowed. Remove finished flags.`,
	]);
});

test("reading a flag the registry does not declare is a compile error", () => {
	// @ts-expect-error: not a declared flag key.
	assert.throws(() => flagDefault("not-a-declared-flag"));
	// @ts-expect-error: a string flag's default must satisfy its schema.
	stringFlag({ ...metadata, schema: z.enum(["v1"]), default: "v2" });
});

test("the browser decoder serves a missing or malformed value at its default", () => {
	const declared: FlagRegistry = featureFlags;
	const defaults = Object.fromEntries(
		clientFlagKeys(declared).map((key) => [key, declared[key]?.default])
	);
	const malformed = Object.fromEntries(
		clientFlagKeys(declared).map((key) => [key, { not: "a flag value" }])
	);
	assert.deepEqual(flagsClientSchema.parse({ flags: {} }).flags, defaults);
	assert.deepEqual(
		flagsClientSchema.parse({ flags: malformed }).flags,
		defaults
	);
});
