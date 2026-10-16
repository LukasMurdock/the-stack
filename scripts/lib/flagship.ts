// Cloudflare Flagship from scripts, through Wrangler's documented CLI: the
// local flag store that dev and browser tests evaluate against, and the
// production app that deploy creates or reuses.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	localCloudflare,
	localFlagshipAppId,
} from "../../config/cloudflare.mjs";
import type {
	FlagDefinition,
	FlagRegistry,
} from "../../src/contracts/feature-flags.ts";
import { e2ePaths } from "../testing/e2e.ts";
import { CommandError } from "./cli.ts";

// Each Wrangler call starts a local runtime; a loaded machine needs about 10 s.
const WRANGLER_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 2_000;
// Flagship's per-app limit; a store listing larger than this is not ours.
const STORE_FLAGS_MAX = 5_000;
// Wrangler refuses local flag commands while a dev session runs a Worker of
// the config's name. The server only reads the store and SQLite serializes
// the CLI's writes, so a change applies to the running server on its next
// evaluation; a name of its own lets a developer flip a flag mid-session.
const CLI_CONFIG_PATH = path.resolve(".wrangler/flags/wrangler.json");

export type FlagStore = {
	readonly label: string;
	readonly appId: string;
	readonly persistTo: string;
};

export const LOCAL_FLAG_STORE: FlagStore = {
	label: ".wrangler/state",
	appId: localFlagshipAppId,
	persistTo: path.resolve(".wrangler/state"),
};

export function e2eFlagStore(port: number): FlagStore {
	return flagStoreAt(e2ePaths(port).state);
}

// The local app's store under a Worker's persist directory.
export function flagStoreAt(persistTo: string): FlagStore {
	return {
		label: path.relative(process.cwd(), persistTo) || ".",
		appId: localFlagshipAppId,
		persistTo,
	};
}

export type WranglerResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
};
export type WranglerRunner = (args: readonly string[]) => WranglerResult;

export const runWrangler: WranglerRunner = (args) => {
	const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
		encoding: "utf8",
		timeout: WRANGLER_TIMEOUT_MS,
	});
	if (result.error !== undefined) throw result.error;
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

const ruleSchema = z.looseObject({
	serve_variation: z.string(),
	priority: z.number(),
	conditions: z.array(z.unknown()),
});
const storedFlagSchema = z.looseObject({
	key: z.string(),
	enabled: z.boolean(),
	default_variation: z.string(),
	variations: z.record(z.string(), z.unknown()),
	rules: z.array(ruleSchema),
});
export type StoredFlag = z.infer<typeof storedFlagSchema>;
const storeListingSchema = z.object({
	items: z.array(storedFlagSchema).max(STORE_FLAGS_MAX),
});
const evaluationSchema = z.object({
	flagKey: z.string(),
	value: z.unknown(),
	variant: z.string().optional(),
	reason: z.string().optional(),
});
export type StoreEvaluation = z.infer<typeof evaluationSchema>;

// One `wrangler flagship flags <command> <app> ...` against a local store.
function storeCommand(
	store: FlagStore,
	command: readonly string[],
	args: readonly string[],
	run: WranglerRunner
): unknown {
	ensureCliConfig();
	const full = [
		"flagship",
		"flags",
		...command,
		store.appId,
		...args,
		"--local",
		"--persist-to",
		store.persistTo,
		"--config",
		CLI_CONFIG_PATH,
		"--json",
	];
	const result = run(full);
	if (result.status !== 0)
		throw new CommandError(
			`wrangler ${full.slice(0, 4).join(" ")} failed (${result.status ?? "killed"}):\n${tail(result.stderr || result.stdout)}`
		);
	return parseJson(result.stdout, full.slice(0, 3).join(" "));
}

function ensureCliConfig(): void {
	mkdirSync(path.dirname(CLI_CONFIG_PATH), { recursive: true });
	writeFileSync(
		CLI_CONFIG_PATH,
		JSON.stringify({
			name: `${localCloudflare.name}-flags-cli`,
			compatibility_date: localCloudflare.compatibility_date,
		})
	);
}

export function listStoredFlags(
	store: FlagStore,
	run: WranglerRunner = runWrangler
): StoredFlag[] {
	return storeListingSchema.parse(storeCommand(store, ["list"], [], run))
		.items;
}

export function evaluateStoredFlag(
	store: FlagStore,
	key: string,
	context: Readonly<Record<string, string>>,
	run: WranglerRunner = runWrangler
): StoreEvaluation {
	const contextArgs = Object.entries(context).flatMap(([name, value]) => [
		"--context",
		`${name}=${value}`,
	]);
	return evaluationSchema.parse(
		storeCommand(store, ["evaluate"], [key, ...contextArgs], run)
	);
}

// Boolean flags get Flagship's usual on/off variations so `serve=on` rules
// work; other types start with one "default" variation holding the default.
export function createArgs(key: string, definition: FlagDefinition): string[] {
	return [
		key,
		...variationArgs(definition),
		"--description",
		definition.description,
	];
}

function variationArgs(definition: FlagDefinition): string[] {
	switch (definition.type) {
		case "boolean":
			return [
				...["-V", "on=true", "-V", "off=false", "--type", "boolean"],
				...["--default", definition.default ? "on" : "off"],
			];
		case "string":
			return [
				...["-V", `default=${definition.default}`, "--type", "string"],
				...["--default", "default"],
			];
		case "number":
			return [
				...["-V", `default=${String(definition.default)}`],
				...["--type", "number", "--default", "default"],
			];
		case "object":
			return [
				...["-V", `default=${JSON.stringify(definition.default)}`],
				...["--type", "json", "--default", "default"],
			];
	}
}

export type SyncResult = {
	readonly created: readonly string[];
	readonly reset: readonly string[];
	readonly kept: readonly string[];
	readonly undeclared: readonly string[];
};

// Writes every declared flag with its default. Flags already in the store
// keep their local rules unless `reset`, so re-running setup does not undo
// a developer's targeting; browser tests always start from a reset store.
export function syncFlags(
	store: FlagStore,
	registry: FlagRegistry,
	options: { readonly reset: boolean },
	run: WranglerRunner = runWrangler
): SyncResult {
	const existing = new Set(listStoredFlags(store, run).map((f) => f.key));
	const created: string[] = [];
	const reset: string[] = [];
	const kept: string[] = [];
	for (const [key, definition] of Object.entries(registry)) {
		if (!existing.has(key)) {
			storeCommand(store, ["create"], createArgs(key, definition), run);
			created.push(key);
		} else if (options.reset) {
			storeCommand(store, ["delete"], [key, "--force"], run);
			storeCommand(store, ["create"], createArgs(key, definition), run);
			reset.push(key);
		} else {
			kept.push(key);
		}
	}
	const undeclared = [...existing].filter(
		(key) => !Object.hasOwn(registry, key)
	);
	return { created, reset, kept, undeclared };
}

export type FlagTarget =
	| { readonly kind: "everyone" }
	| { readonly kind: "user"; readonly id: string }
	| { readonly kind: "organization"; readonly id: string };

// Serves a boolean flag's "on" or "off" variation. A user or organization
// target appends a targeting rule, the same one a developer would write by
// hand; "everyone" changes the default and clears the rules.
export function serveBooleanFlag(
	store: FlagStore,
	key: string,
	change: { readonly variation: "on" | "off"; readonly target: FlagTarget },
	run: WranglerRunner = runWrangler
): void {
	if (change.target.kind === "everyone") {
		storeCommand(
			store,
			["set"],
			[key, "--variation", change.variation, "--clear-rules"],
			run
		);
		return;
	}
	const attribute =
		change.target.kind === "user" ? "userId" : "organizationId";
	storeCommand(
		store,
		["update"],
		[
			key,
			"--add-rule",
			targetRule(change.variation, attribute, change.target.id),
		],
		run
	);
}

export function targetRule(
	variation: "on" | "off",
	attribute: "userId" | "organizationId",
	id: string
): string {
	return `serve=${variation}; when=${attribute} equals "${id}"`;
}

const appSchema = z.looseObject({ id: z.string().min(1), name: z.string() });

export type FlagshipApp = {
	readonly appId: string;
	readonly action: "reused" | "created";
};

// The production app is found by the Worker's name, or created, so a rerun
// never creates a second one and no ID has to be copied by hand.
export function ensureFlagshipApp(
	args: { readonly appName: string; readonly configPath: string },
	run: WranglerRunner = runWrangler
): FlagshipApp {
	const configArgs = ["--config", args.configPath, "--json"];
	const listed = run(["flagship", "apps", "list", ...configArgs]);
	if (listed.status !== 0)
		throw new Error(flagshipAppHelp(args, `listing apps failed`, listed));
	const apps = z
		.array(appSchema)
		.parse(parseJson(listed.stdout, "flagship apps list"));
	const named = apps.filter((app) => app.name === args.appName);
	const [only] = named;
	if (named.length > 1)
		throw new Error(
			`Several Flagship apps are named ${args.appName} (${named.map((app) => app.id).join(", ")}). Set app_id on the FLAGS binding in config/cloudflare.mjs to the one this Worker uses, then rerun pnpm run deploy.`
		);
	if (only !== undefined) return { appId: only.id, action: "reused" };
	const created = run([
		"flagship",
		"apps",
		"create",
		args.appName,
		...configArgs,
	]);
	if (created.status !== 0)
		throw new Error(
			flagshipAppHelp(args, `creating the app failed`, created)
		);
	const app = appSchema.parse(
		parseJson(created.stdout, "flagship apps create")
	);
	return { appId: app.id, action: "created" };
}

function flagshipAppHelp(
	args: { readonly appName: string },
	what: string,
	result: WranglerResult
): string {
	return [
		`Flagship ${what} (${result.status ?? "killed"}):`,
		tail(result.stderr || result.stdout),
		"The FLAGS binding needs a Flagship app. Create it once with:",
		`  pnpm exec wrangler flagship apps create ${args.appName}`,
		"then rerun pnpm run deploy, which finds it by name. If the deploy",
		"credentials cannot list apps (flagship:read), also set app_id on the",
		"FLAGS binding in config/cloudflare.mjs (deploymentCloudflare.flagship).",
	].join("\n");
}

function parseJson(text: string, command: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new CommandError(
			`wrangler ${command} printed something other than JSON:\n${tail(text)}`
		);
	}
}

function tail(text: string): string {
	return text.trim().slice(-OUTPUT_TAIL_CHARS);
}
