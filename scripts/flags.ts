import { DAY_MS } from "../src/lib/time.ts";
// `pnpm flags`: the feature flag registry next to what the local Flagship
// store serves, and the few store changes a developer needs. Production
// flags are changed with Flagship itself (dashboard or `wrangler flagship`);
// see docs/DEPLOYMENT_GUIDE.md.

import {
	featureFlags,
	flagRegistryProblems,
	parseExpires,
	type FlagDefinition,
	type FlagRegistry,
} from "../src/contracts/feature-flags.ts";
import {
	type Command,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	e2eFlagStore,
	evaluateStoredFlag,
	type FlagStore,
	type FlagTarget,
	LOCAL_FLAG_STORE,
	listStoredFlags,
	serveBooleanFlag,
	type StoredFlag,
	syncFlags,
} from "./lib/flagship.ts";
import { e2ePortFromEnv } from "./testing/e2e.ts";

export const FLAGS_USAGE = `Usage: pnpm flags [list|sync|on|off] [key] [options]

  list                 The registry and what the local store serves (default).
  sync [--reset]       Write each declared flag with its default into the
                       local store (also \`pnpm flags:local\`). Flags already
                       there keep their local rules unless --reset.
  on <key>             Serve a boolean flag on: to everyone, or with --user or
                       --organization only to that ID (a targeting rule).
  off <key>            Serve a boolean flag off to everyone.

Options:
  --user <id>          list: evaluate for this user. on: target this user.
  --organization <id>  list: evaluate for this organization. on: target it.
  --e2e                Use the browser-test store for STACK_E2E_PORT (default
                       4322) instead of .wrangler/state.

Flags are declared in src/contracts/feature-flags.ts.`;

// IDs go into a targeting rule; our user and organization IDs fit this.
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Subject = {
	readonly userId?: string;
	readonly organizationId?: string;
};

export type FlagsOptions =
	| {
			readonly kind: "list";
			readonly store: FlagStore;
			readonly subject: Subject;
	  }
	| {
			readonly kind: "sync";
			readonly store: FlagStore;
			readonly reset: boolean;
	  }
	| {
			readonly kind: "serve";
			readonly store: FlagStore;
			readonly key: string;
			readonly variation: "on" | "off";
			readonly target: FlagTarget;
	  };

export function parseFlagsOptions(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	registry: FlagRegistry = featureFlags
): Command<FlagsOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		user: { type: "string" },
		organization: { type: "string" },
		reset: { type: "boolean" },
		e2e: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	const [command = "list", ...rest] = positionals;
	const store = values.e2e === true ? e2eStore(env) : LOCAL_FLAG_STORE;
	const subject = parseSubject(values.user, values.organization);
	if (command !== "sync" && values.reset === true)
		throw new UsageError("--reset only applies to sync.");
	switch (command) {
		case "list":
			rejectExtra(rest);
			return { kind: "run", options: { kind: "list", store, subject } };
		case "sync":
			rejectExtra(rest);
			if (
				subject.userId !== undefined ||
				subject.organizationId !== undefined
			)
				throw new UsageError("sync takes no --user or --organization.");
			return {
				kind: "run",
				options: { kind: "sync", store, reset: values.reset === true },
			};
		case "on":
		case "off":
			return {
				kind: "run",
				options: {
					kind: "serve",
					store,
					key: parseBooleanKey(rest, registry),
					variation: command,
					target: parseTarget(command, subject),
				},
			};
		default:
			throw new UsageError(`Unknown command "${command}".`);
	}
}

function rejectExtra(rest: readonly string[]): void {
	if (rest.length > 0)
		throw new UsageError(`Unexpected argument: ${rest.join(" ")}.`);
}

function e2eStore(env: Readonly<Record<string, string | undefined>>) {
	try {
		return e2eFlagStore(e2ePortFromEnv(env));
	} catch (error: unknown) {
		throw new UsageError(
			error instanceof Error ? error.message : String(error)
		);
	}
}

function parseSubject(
	user: string | undefined,
	organization: string | undefined
): Subject {
	for (const [name, id] of [
		["--user", user],
		["--organization", organization],
	] as const)
		if (id !== undefined && !SUBJECT_ID_PATTERN.test(id))
			throw new UsageError(
				`${name} must be an ID of 1-128 letters, digits, - or _, got "${id}".`
			);
	return {
		...(user === undefined ? {} : { userId: user }),
		...(organization === undefined ? {} : { organizationId: organization }),
	};
}

function parseBooleanKey(
	rest: readonly string[],
	registry: FlagRegistry
): string {
	const [key, ...extra] = rest;
	if (key === undefined) throw new UsageError("Give the flag key.");
	if (extra.length > 0)
		throw new UsageError(`Unexpected argument: ${extra.join(" ")}.`);
	const definition = registry[key];
	if (definition === undefined)
		throw new UsageError(
			`"${key}" is not declared in src/contracts/feature-flags.ts.`
		);
	if (definition.type !== "boolean")
		throw new UsageError(
			`"${key}" is a ${definition.type} flag; on and off only change boolean flags. Use wrangler flagship flags update --local for other values.`
		);
	return key;
}

function parseTarget(variation: "on" | "off", subject: Subject): FlagTarget {
	if (subject.userId !== undefined && subject.organizationId !== undefined)
		throw new UsageError(
			"Target either --user or --organization, not both."
		);
	const targeted =
		subject.userId !== undefined || subject.organizationId !== undefined;
	if (variation === "off" && targeted)
		throw new UsageError(
			"off serves off to everyone; to drop a targeting rule, run sync --reset."
		);
	if (subject.userId !== undefined)
		return { kind: "user", id: subject.userId };
	if (subject.organizationId !== undefined)
		return { kind: "organization", id: subject.organizationId };
	return { kind: "everyone" };
}

export async function runFlags(options: FlagsOptions): Promise<void> {
	switch (options.kind) {
		case "list":
			listFlags(options.store, options.subject, Date.now());
			return;
		case "sync":
			reportSync(options.store, options.reset);
			return;
		case "serve":
			serveFlag(options);
			return;
	}
}

function serveFlag(options: Extract<FlagsOptions, { kind: "serve" }>): void {
	const present = listStoredFlags(options.store).some(
		(flag) => flag.key === options.key
	);
	if (!present) syncFlags(options.store, featureFlags, { reset: false });
	serveBooleanFlag(options.store, options.key, options);
	const who =
		options.target.kind === "everyone"
			? "everyone"
			: `${options.target.kind} ${options.target.id}`;
	write(
		`${options.key} now serves ${options.variation} to ${who} in ${options.store.label}. A running server picks it up on its next request.`
	);
}

function reportSync(store: FlagStore, reset: boolean): void {
	const result = syncFlags(store, featureFlags, { reset });
	const declared = Object.keys(featureFlags).length;
	write(`Local flag store ${store.label}: ${declared} declared flag(s).`);
	for (const key of result.created)
		write(`  created  ${key} (registry default)`);
	for (const key of result.reset)
		write(`  reset    ${key} (registry default)`);
	for (const key of result.kept)
		write(
			`  kept     ${key} (local rules kept; sync --reset restores the default)`
		);
	for (const key of result.undeclared)
		write(`  stale    ${key} is in the store but not the registry`);
}

function listFlags(
	store: FlagStore,
	subject: Subject,
	nowUnixMs: number
): void {
	const registry: FlagRegistry = featureFlags;
	const keys = Object.keys(registry);
	const stored = new Map(
		listStoredFlags(store).map((flag) => [flag.key, flag])
	);
	const context = {
		...(subject.userId === undefined ? {} : { userId: subject.userId }),
		...(subject.organizationId === undefined
			? {}
			: { organizationId: subject.organizationId }),
	};
	const scope =
		Object.keys(context).length === 0
			? "no context"
			: JSON.stringify(context);
	write(
		`Feature flags (src/contracts/feature-flags.ts); local store ${store.label}, evaluated with ${scope}:`
	);
	if (keys.length === 0) write("\nNo flags declared.");
	for (const key of keys) {
		const definition = registry[key];
		if (definition === undefined) continue;
		write(`\n${describeDefinition(key, definition, nowUnixMs)}`);
		write(`  ${definition.description}`);
		write(`  ${describeStored(store, key, stored.get(key), context)}`);
	}
	const problems = flagRegistryProblems(featureFlags, { nowUnixMs });
	for (const { key, problem } of problems)
		write(`\nPROBLEM ${key}: ${problem}`);
	for (const key of stored.keys())
		if (!Object.hasOwn(featureFlags, key))
			write(
				`\nStale: ${key} is in the local store but not the registry.`
			);
}

function describeDefinition(
	key: string,
	definition: FlagDefinition,
	nowUnixMs: number
): string {
	return `${key}  ${definition.type}, default ${JSON.stringify(definition.default)}, ${definition.exposure}, owner ${definition.owner}, expires ${definition.expires} (${timeLeft(definition.expires, nowUnixMs)})`;
}

function timeLeft(expires: string, nowUnixMs: number): string {
	const expiresUnixMs = parseExpires(expires);
	if (expiresUnixMs === undefined) return "invalid date";
	if (expiresUnixMs <= nowUnixMs) return "EXPIRED";
	return `${Math.ceil((expiresUnixMs - nowUnixMs) / DAY_MS)} days left`;
}

function describeStored(
	store: FlagStore,
	key: string,
	flag: StoredFlag | undefined,
	context: Readonly<Record<string, string>>
): string {
	if (flag === undefined)
		return "local: not in the store, so the app serves the default (run pnpm flags:local)";
	const evaluation = evaluateStoredFlag(store, key, context);
	const rules =
		flag.rules.length === 0 ? "no rules" : `${flag.rules.length} rule(s)`;
	return `local: serves ${JSON.stringify(evaluation.value)} (${evaluation.reason ?? "no reason"}; ${flag.enabled ? "enabled" : "disabled"}, ${rules})`;
}

function write(line: string): void {
	process.stdout.write(`${line}\n`);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: FLAGS_USAGE,
		parse: () => parseFlagsOptions(process.argv.slice(2), process.env),
		run: runFlags,
	});
