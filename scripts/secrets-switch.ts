// The one-time switch of a live Worker from plain secrets to Cloudflare
// Secrets Store, outside Void (which would pin the plain secrets) and with no
// sign-in outage. Every phase is a dry run (reads and a local build) unless
// --execute. The runbook is docs/DEPLOYMENT_GUIDE.md, "Switching a Worker
// that already has plain secrets".
//
//   store           Finds the account's store (or, with --execute, creates
//                   default_secrets_store) and records it in void.lock.json.
//   create-secrets  Creates each bound secret the store lacks with a new
//                   random value, written to Wrangler's stdin.
//   switch          Builds the Store-based Worker, uploads it as a version
//                   with no traffic, checks that it binds every secret from
//                   the Store and is ready on its preview URL, then deploys
//                   it at 100%. Cloudflare accepts Store bindings named like
//                   the live plain secrets, and the new version no longer
//                   has those plain secrets, so nothing fails in between.
//                   Only with --allow-auth-window, if Cloudflare refuses
//                   that upload: bridge, delete the plain secrets, deploy,
//                   with a short window in which sign-in fails closed.
//
// Cloudflare access is Wrangler's own (CLOUDFLARE_API_TOKEN or `wrangler
// login`), against the account `void connect` pinned in the generated config,
// as for `pnpm run deploy`. No secret value is printed or passed in argv.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
	deploymentCloudflare,
	SECRETS_STORE_ID_UNPROVISIONED,
} from "../config/cloudflare.mjs";
import { secretCreateCommand } from "../src/contracts/secrets.ts";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import { runWrangler } from "./lib/flagship.ts";
import {
	LIVE_CONFIRMATIONS_COUNT,
	parseHealth,
	productionOrigin,
} from "./lib/release.ts";
import {
	ensureSecretsStore,
	listSecretsStores,
	listStoreSecrets,
} from "./lib/secrets-store.ts";
import {
	activeVersion,
	bridgeConfig,
	splitByValueSource,
	deletionPayload,
	isBindingNameConflict,
	type LiveBinding,
	parseBookmark,
	parseLoggedIn,
	parseVersionBindings,
	plainSecretNames,
	preflightProblems,
	readinessProblem,
	type StoreEntry,
	storeBindingsVerdict,
	turretProblem,
	unusableSecrets,
	uploadedPreviewUrl,
	uploadedVersionId,
} from "./lib/secrets-switch.ts";
import { loadVoidProvisioning } from "./lib/void-cloudflare.ts";
import { normalizeVoidLock } from "./lib/void-lock.ts";
import {
	readCloudflareConfig,
	recordSecretsStore,
} from "./provision-resources.mjs";

// Bytes of CSPRNG output per new secret: 43 base64url characters, above
// every minimum in src/contracts/secrets.ts.
export const NEW_SECRET_BYTES = 32;
// A new version's preview URL can take a few seconds to answer.
export const PREVIEW_READY_TIMEOUT_MS = 2 * 60_000;
// Until production serves the deployed version LIVE_CONFIRMATIONS_COUNT
// times in a row.
export const LIVE_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BUILT_CONFIG = path.join("dist", "server", "wrangler.json");
const BRIDGE_CONFIG = path.join("dist", "server", "wrangler.bridge.json");
const SWITCH_MESSAGE = "Switch secrets to Secrets Store";
const VERSION_PREFIX = /^[0-9a-f][0-9a-f-]{0,35}$/;

export const SECRETS_SWITCH_USAGE = `Usage: pnpm secrets:switch <store|create-secrets|switch> [options]

The one-time switch of a live Worker from plain secrets to Cloudflare Secrets
Store (docs/DEPLOYMENT_GUIDE.md, "Switching a Worker that already has plain
secrets"). A dry run (reads and a local build only) unless --execute.

  store                   Find (or create) the account's store and record it
                          in void.lock.json.
  create-secrets          Create each bound secret the store lacks with a new
                          random value (on Wrangler's stdin, never printed).
  switch                  Upload the Store-based Worker without traffic,
                          check it, then deploy it at 100%.

  --execute               Make the changes.
  --dry-run               The default; say it explicitly.
  --expect-version <id>   switch: refuse unless the live Worker serves this
                          version (a prefix is enough).
  --allow-auth-window     switch: if Cloudflare refuses Store bindings named
                          like the live plain secrets, bridge, delete them and
                          deploy, with a short window in which sign-in fails.
  -h, --help              Show this help.`;

export type SecretsSwitchPhase = "store" | "create-secrets" | "switch";
export type SecretsSwitchOptions = {
	readonly phase: SecretsSwitchPhase;
	readonly execute: boolean;
	readonly expectVersion: string | null;
	readonly allowAuthWindow: boolean;
};

function parsePhase(value: string | undefined): SecretsSwitchPhase {
	if (value === "store" || value === "create-secrets" || value === "switch")
		return value;
	throw new UsageError(
		value === undefined
			? "Name a phase: store, create-secrets or switch."
			: `Unknown phase "${value}": use store, create-secrets or switch.`
	);
}

export function parseSecretsSwitchOptions(
	argv: readonly string[]
): Command<SecretsSwitchOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		execute: { type: "boolean" },
		"dry-run": { type: "boolean" },
		"expect-version": { type: "string" },
		"allow-auth-window": { type: "boolean" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	const [first, ...rest] = positionals;
	const phase = parsePhase(first);
	if (rest.length > 0)
		throw new UsageError(`Unexpected argument: ${rest.join(" ")}.`);
	if (values.execute === true && values["dry-run"] === true)
		throw new UsageError("--execute and --dry-run exclude each other.");
	const expectVersion = values["expect-version"] ?? null;
	if (expectVersion !== null && !VERSION_PREFIX.test(expectVersion))
		throw new UsageError(
			`--expect-version takes a Worker version ID or its prefix, got "${expectVersion}".`
		);
	const allowAuthWindow = values["allow-auth-window"] === true;
	if (phase !== "switch" && (expectVersion !== null || allowAuthWindow))
		throw new UsageError(
			"--expect-version and --allow-auth-window apply to the switch phase."
		);
	return {
		kind: "run",
		options: {
			phase,
			execute: values.execute === true,
			expectVersion,
			allowAuthWindow,
		},
	};
}

// 32 bytes from the CSPRNG, base64url.
export function newSecretValue(): string {
	return randomBytes(NEW_SECRET_BYTES).toString("base64url");
}

// --- Processes -----------------------------------------------------------------

function step(message: string): void {
	process.stdout.write(`\n==> ${message}\n`);
}

function say(message: string): void {
	process.stdout.write(`${message}\n`);
}

function git(args: readonly string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0)
		throw new CommandError(
			`git ${args.join(" ")} failed: ${result.stderr.trim()}`
		);
	return result.stdout.trim();
}

type Streamed = { readonly status: number | null; readonly output: string };

// Runs a command with its output shown and kept. `input` goes to stdin and is
// never shown: secret values travel only this way.
function stream(
	command: string,
	args: readonly string[],
	input = ""
): Promise<Streamed> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			process.stderr.write(chunk);
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, output }));
		child.stdin.end(input);
	});
}

async function mustStream(
	command: string,
	args: readonly string[],
	input = ""
): Promise<string> {
	const result = await stream(command, args, input);
	if (result.status !== 0)
		throw new CommandError(
			`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}.`
		);
	return result.output;
}

const wrangler = (...args: string[]) => ["exec", "wrangler", ...args];

// A read through Wrangler; its output is parsed, not shown.
function read(args: readonly string[], what: string): string {
	const result = runWrangler(args);
	if (result.status !== 0)
		throw new CommandError(
			`${what} failed (wrangler ${args.slice(0, 3).join(" ")}):\n${(result.stderr || result.stdout).trim().slice(-2_000)}`
		);
	return result.stdout;
}

// --- The app -------------------------------------------------------------------

type App = {
	readonly root: string;
	readonly configPath: string;
	readonly worker: string;
	readonly entries: readonly StoreEntry[];
	readonly databases: readonly string[];
	readonly storeRecorded: boolean;
	readonly persist: (root: string) => void;
};

const unprovisioned = (entry: StoreEntry) =>
	entry.store_id === SECRETS_STORE_ID_UNPROVISIONED;

// The production config as deploy sees it: void.config.ts merged with the
// IDs void.lock.json records, written to the generated config Wrangler reads.
async function loadApp(): Promise<App> {
	const root = process.cwd();
	normalizeVoidLock(root);
	const sdk = await loadVoidProvisioning();
	const configPath = sdk.materializeCloudflareConfig(root);
	const config = readCloudflareConfig(configPath);
	const entries = config.secrets_store_secrets ?? [];
	if (entries.length === 0)
		throw new CommandError(
			"The production config binds no secrets from Secrets Store (productionSecretNames in config/cloudflare.mjs)."
		);
	// Wrangler reads the account from the generated config; the built and
	// bridge configs it uploads may not carry it, and with several accounts
	// a non-interactive Wrangler would stop to ask.
	if (config.account_id !== undefined && !process.env.CLOUDFLARE_ACCOUNT_ID)
		process.env.CLOUDFLARE_ACCOUNT_ID = config.account_id;
	return {
		root,
		configPath,
		worker: config.name,
		entries,
		databases: (config.d1_databases ?? []).map((db) => db.binding),
		storeRecorded: !entries.some(unprovisioned),
		persist: sdk.persistCloudflareConfig,
	};
}

function assertCredentials(): void {
	const result = runWrangler(["whoami", "--json"]);
	if (!result.stdout.includes('"loggedIn"'))
		throw new CommandError(
			`wrangler whoami failed:\n${(result.stderr || result.stdout).trim().slice(-2_000)}`
		);
	if (!parseLoggedIn(result.stdout))
		throw new CommandError(
			"Wrangler has no Cloudflare credentials. Set CLOUDFLARE_API_TOKEN (the token `pnpm run deploy` uses) or run `pnpm exec wrangler login`, then rerun. Nothing was read or changed."
		);
}

// --- Phase: store ----------------------------------------------------------------

function storePhase(app: App, options: SecretsSwitchOptions): void {
	if (app.storeRecorded) {
		say(
			`void.lock.json already records store ${app.entries[0]?.store_id ?? "?"}. Next: pnpm secrets:switch create-secrets`
		);
		return;
	}
	step("Finding the account's Secrets Store (read-only)");
	const stores = listSecretsStores(
		{ configPath: app.configPath },
		runWrangler
	);
	for (const store of stores) say(`  ${store.name} ${store.id}`);
	if (!options.execute) {
		if (stores.length === 0)
			say(
				"No store yet. --execute would create default_secrets_store and record it in void.lock.json."
			);
		else if (stores.length === 1)
			say("--execute would record it in void.lock.json.");
		else
			say(
				"Several stores: set store_id in config/cloudflare.mjs to the one to use."
			);
		return;
	}
	const store = ensureSecretsStore(
		{ configPath: app.configPath },
		runWrangler
	);
	recordSecretsStore(app.root, app.configPath, store.storeId, app.persist);
	say(
		`${store.action === "created" ? "Created" : "Found"} store ${store.storeId}; recorded in void.lock.json. Commit and push void.lock.json, then: pnpm secrets:switch create-secrets`
	);
}

// --- Phase: create-secrets -------------------------------------------------------

function storeId(app: App): string {
	const ids = new Set(app.entries.map((entry) => entry.store_id));
	const [only] = ids;
	if (!app.storeRecorded || only === undefined)
		throw new CommandError(
			"void.lock.json records no Secrets Store yet; run `pnpm secrets:switch store` first."
		);
	if (ids.size > 1)
		throw new CommandError(
			`The config binds from several stores (${[...ids].join(", ")}); the switch handles one.`
		);
	return only;
}

function readUnusable(app: App, id: string) {
	return unusableSecrets(
		app.entries,
		listStoreSecrets(
			{ storeId: id, configPath: app.configPath },
			runWrangler
		)
	);
}

function createSecret(app: App, id: string, entry: StoreEntry) {
	step(`Creating ${entry.secret_name} (new value from the CSPRNG, on stdin)`);
	return mustStream(
		"pnpm",
		wrangler(
			"secrets-store",
			"secret",
			"create",
			id,
			"--name",
			entry.secret_name,
			"--scopes",
			"workers",
			"--comment",
			`${app.worker} ${entry.binding}`,
			"--remote",
			"--config",
			app.configPath
		),
		newSecretValue()
	);
}

async function createSecretsPhase(app: App, options: SecretsSwitchOptions) {
	const id = storeId(app);
	step(`Secrets in store ${id} (read-only: names and scopes)`);
	const { missing, unscoped } = readUnusable(app, id);
	if (unscoped.length > 0)
		throw new CommandError(
			`${unscoped.map((entry) => entry.secret_name).join(", ")} lack the "workers" scope; add it in the dashboard (Secrets Store) and rerun.`
		);
	const { generated, provided } = splitByValueSource(missing);
	for (const entry of generated)
		say(`  missing, new random value  ${entry.secret_name}`);
	for (const entry of provided)
		say(
			`  missing, provider-issued   ${entry.secret_name}: ${secretCreateCommand(id, entry.secret_name)}`
		);
	if (missing.length === 0) {
		say("Every bound secret exists. Next: pnpm secrets:switch switch");
		return;
	}
	if (!options.execute) {
		say(
			`--execute would create each random one on Wrangler's stdin. To keep a value you still have (an unchanged BETTER_AUTH_SECRET signs nobody out), create it yourself first: ${secretCreateCommand(id, "<name>")} prompts for it.`
		);
		return;
	}
	for (const entry of generated) await createSecret(app, id, entry);
	const after = readUnusable(app, id);
	const left = [...after.missing, ...after.unscoped];
	if (left.length > 0)
		throw new CommandError(
			`Still missing: ${left.map((entry) => entry.secret_name).join(", ")}. Create provider-issued ones with the commands above (Wrangler prompts for the value), then rerun.`
		);
	const signOut = generated.some(
		(entry) => entry.binding === "BETTER_AUTH_SECRET"
	);
	say(
		`Every bound secret exists.${signOut ? " BETTER_AUTH_SECRET is new: everyone signs in again after the switch." : ""} Next: pnpm secrets:switch switch`
	);
}

// --- Cloudflare reads ------------------------------------------------------------

function servingVersion(app: App): string | null {
	return activeVersion(
		read(
			[
				"deployments",
				"status",
				"--name",
				app.worker,
				"--json",
				"--config",
				app.configPath,
			],
			`Reading ${app.worker}'s deployment`
		)
	);
}

function versionBindings(app: App, versionId: string): readonly LiveBinding[] {
	return parseVersionBindings(
		read(
			[
				"versions",
				"view",
				versionId,
				"--name",
				app.worker,
				"--json",
				"--config",
				app.configPath,
			],
			`Reading version ${versionId}`
		)
	);
}

function printBookmarks(app: App): void {
	step(
		"D1 Time Travel bookmarks (read-only), to restore data to this moment"
	);
	for (const database of app.databases) {
		const result = runWrangler([
			"d1",
			"time-travel",
			"info",
			database,
			"--json",
			"--config",
			app.configPath,
		]);
		if (result.status !== 0) {
			say(
				`  ${database}: unavailable (${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? "no output"})`
			);
			continue;
		}
		const bookmark = parseBookmark(result.stdout);
		say(
			`  ${database}: ${bookmark}\n    restore: pnpm exec wrangler d1 time-travel restore ${database} --bookmark=${bookmark} --config ${path.relative(app.root, app.configPath)}`
		);
	}
}

// --- Probes ------------------------------------------------------------------------

type Probe = { readonly status: number; readonly body: string };

async function probe(url: string): Promise<Probe> {
	const response = await fetch(url, {
		headers: { "cache-control": "no-cache" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	return { status: response.status, body: await response.text() };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// Polls a version's preview URL until readiness proves every required secret
// resolved there, or the deadline passes.
async function waitUntilReady(origin: string): Promise<void> {
	const deadlineMs = Date.now() + PREVIEW_READY_TIMEOUT_MS;
	let last = "no answer yet";
	while (Date.now() < deadlineMs) {
		try {
			const ready = await probe(`${origin}/api/readiness`);
			const problem = readinessProblem(ready.status, ready.body);
			if (problem === null) {
				say(
					`  ${origin}/api/readiness: 200, secrets.missingRequired []`
				);
				return;
			}
			last = problem;
		} catch (error: unknown) {
			// Expected while the preview URL comes up; reported at the deadline.
			last = describe(error);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new CommandError(`${origin} is not ready: ${last}.`);
}

// Polls /api/health until production serves `version` several times in a row.
async function waitUntilServing(origin: string, version: string) {
	const deadlineMs = Date.now() + LIVE_TIMEOUT_MS;
	let confirmations = 0;
	let last = "no answer yet";
	while (Date.now() < deadlineMs) {
		try {
			const health = parseHealth(
				(await probe(`${origin}/api/health`)).body
			);
			last =
				health.kind === "served"
					? `version ${health.version}`
					: health.reason;
			confirmations =
				health.kind === "served" && health.version === version
					? confirmations + 1
					: 0;
		} catch (error: unknown) {
			// Expected while the deploy propagates; reported at the deadline.
			last = describe(error);
			confirmations = 0;
		}
		if (confirmations >= LIVE_CONFIRMATIONS_COUNT) return;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new CommandError(
		`${origin} did not serve ${version} in time (${last}).`
	);
}

// --- Phase: switch -----------------------------------------------------------------

function cleanMain(): boolean {
	git(["fetch", "--quiet", "origin", "main"]);
	return (
		git(["status", "--porcelain"]) === "" &&
		git(["rev-parse", "--abbrev-ref", "HEAD"]) === "main" &&
		git(["rev-parse", "HEAD"]) === git(["rev-parse", "origin/main"])
	);
}

type Live = {
	readonly version: string | null;
	readonly switched: boolean;
	readonly problems: readonly string[];
};

function preflight(
	app: App,
	options: SecretsSwitchOptions,
	clean: boolean
): Live {
	step("Preflight (read-only)");
	const version = servingVersion(app);
	const bindings = version === null ? [] : versionBindings(app, version);
	const plain = plainSecretNames(bindings);
	const bound = new Set(app.entries.map((entry) => entry.binding));
	let unusable = app.entries.map((entry) => entry.secret_name);
	if (app.storeRecorded) {
		const found = readUnusable(app, storeId(app));
		unusable = [...found.missing, ...found.unscoped].map(
			(entry) => entry.secret_name
		);
	}
	say(`  ${app.worker} serves ${version ?? "(split traffic)"}`);
	say(`  live plain secrets: ${plain.join(", ") || "none"}`);
	say(
		`  Store bindings to deploy: ${app.entries.map((entry) => `${entry.binding}=${entry.secret_name}`).join(", ")}`
	);
	return {
		version,
		switched:
			plain.length === 0 &&
			storeBindingsVerdict(app.entries, bindings).kind === "store",
		problems: preflightProblems({
			cleanMain: clean,
			storeRecorded: app.storeRecorded,
			unusableSecrets: unusable,
			unboundPlain: plain.filter((name) => !bound.has(name)),
			activeVersion: version,
			expectedVersion: options.expectVersion,
		}),
	};
}

// The build Void runs (`pnpm run check` proves Void's artifact first), as
// plain Wrangler uploads it, plus the bridge config for the fallback.
async function build(app: App): Promise<void> {
	step(
		"Building: pnpm run check (Void's artifact, offline), then pnpm run build"
	);
	await mustStream("pnpm", ["run", "check"]);
	await mustStream("pnpm", ["run", "build"]);
	const built = z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(readFileSync(BUILT_CONFIG, "utf8")));
	const store = z
		.array(
			z.looseObject({
				binding: z.string(),
				store_id: z.string(),
				secret_name: z.string(),
			})
		)
		.parse(built.secrets_store_secrets ?? []);
	const expected = app.entries.map(
		(entry) => `${entry.binding}=${entry.store_id}/${entry.secret_name}`
	);
	const actual = store.map(
		(entry) => `${entry.binding}=${entry.store_id}/${entry.secret_name}`
	);
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new CommandError(
			`${BUILT_CONFIG} binds ${actual.join(", ") || "nothing"} from the Store, not ${expected.join(", ")}.`
		);
	writeFileSync(
		BRIDGE_CONFIG,
		`${JSON.stringify(bridgeConfig(built), null, 2)}\n`
	);
}

async function switchPhase(app: App, options: SecretsSwitchOptions) {
	const origin = productionOrigin(deploymentCloudflare.vars.APP_URL);
	const clean = cleanMain();
	const live = preflight(app, options, clean);
	if (live.switched) {
		say(
			`\n${app.worker} binds every secret from the Store and has no plain secrets: the switch is done. Deploy with pnpm run deploy.`
		);
		return;
	}
	for (const problem of live.problems) say(`  PROBLEM ${problem}`);
	printBookmarks(app);
	say(
		`  Rollback while the old version keeps its plain secrets: pnpm exec wrangler rollback ${live.version ?? "<version>"} --name ${app.worker} --config ${path.relative(app.root, app.configPath)}`
	);
	await build(app);
	if (!options.execute) {
		say(
			`\nDry run complete${live.problems.length > 0 ? ` with ${live.problems.length} problem(s)` : ""}. --execute would: upload the Store-based version without traffic; if it binds every secret from the Store and is ready on its preview URL, deploy it at 100%; otherwise ${options.allowAuthWindow ? "bridge, delete the plain secrets and deploy" : "stop (--allow-auth-window takes the fallback)"}; then verify with anonymous probes.`
		);
		if (live.problems.length > 0) process.exitCode = 1;
		return;
	}
	if (live.problems.length > 0)
		throw new CommandError(
			"Preflight failed; nothing was changed. Resolve the problems above."
		);
	const direct = await uploadStoreVersion(app);
	if (direct !== null) await deployVersion(app, direct);
	else await fallback(app, origin, live.version, options);
	await removeLeftoverPlain(app);
	await verify(app, origin, live.version);
}

// Uploads the Store-based build without traffic. Returns its version when
// it binds every secret from the Store and is ready on its preview URL;
// null when Cloudflare refused the same-name Store bindings.
async function uploadStoreVersion(app: App): Promise<string | null> {
	step("1. Uploading the Store-based version (no traffic)");
	const upload = await stream(
		"pnpm",
		wrangler(
			"versions",
			"upload",
			"--config",
			BUILT_CONFIG,
			"--message",
			SWITCH_MESSAGE
		)
	);
	if (upload.status !== 0) {
		if (!isBindingNameConflict(upload.output))
			throw new CommandError(
				"The upload failed for a reason other than a binding name conflict; production is unchanged. Fix the cause and rerun."
			);
		say(
			"  Cloudflare refused Store bindings named like the live plain secrets."
		);
		return null;
	}
	const versionId = uploadedVersionId(upload.output);
	if (versionId === null)
		throw new CommandError(
			"Wrangler uploaded a version but printed no Version ID; production is unchanged. Inspect `pnpm exec wrangler versions list` and rerun."
		);
	const verdict = storeBindingsVerdict(
		app.entries,
		versionBindings(app, versionId)
	);
	if (verdict.kind !== "store") {
		say(
			`  Version ${versionId} does not bind every secret from the Store (${verdict.problems.join("; ")}); it takes no traffic.`
		);
		return null;
	}
	const preview = uploadedPreviewUrl(upload.output);
	if (preview === null)
		throw new CommandError(
			`Version ${versionId} has no preview URL (preview_urls is off), so it cannot be checked before taking traffic; production is unchanged. Turn preview_urls on in config/cloudflare.mjs, or check and deploy it yourself: pnpm exec wrangler versions deploy ${versionId}@100% --name ${app.worker}`
		);
	await waitUntilReady(preview);
	return versionId;
}

async function deployVersion(app: App, versionId: string): Promise<void> {
	step(`2. Deploying ${versionId} at 100%`);
	await mustStream(
		"pnpm",
		wrangler(
			"versions",
			"deploy",
			`${versionId}@100%`,
			"--name",
			app.worker,
			"--yes",
			"--message",
			SWITCH_MESSAGE,
			"--config",
			app.configPath
		)
	);
}

function bulkDelete(app: App, names: readonly string[]): Promise<string> {
	return mustStream(
		"pnpm",
		wrangler(
			"secret",
			"bulk",
			"--name",
			app.worker,
			"--config",
			app.configPath
		),
		deletionPayload(names)
	);
}

// Only with --allow-auth-window: the bridge keeps the plain secrets, then
// they are deleted in one request and the Store-based Worker deployed at
// once. Between those two steps sign-in fails closed (requireSecret refuses
// to construct auth without BETTER_AUTH_SECRET); nothing falls back.
async function fallback(
	app: App,
	origin: string,
	previous: string | null,
	options: SecretsSwitchOptions
): Promise<void> {
	if (!options.allowAuthWindow)
		throw new CommandError(
			"Stopped before the fallback; production is unchanged (an uploaded version, if any, has no traffic). Rerun with --allow-auth-window to bridge, delete the plain secrets and deploy, accepting a short sign-in outage."
		);
	step("2a. Deploying the bridge (same build, plain secrets kept)");
	await mustStream("pnpm", wrangler("deploy", "--config", BRIDGE_CONFIG));
	const bridge = servingVersion(app);
	if (bridge === null || bridge === previous)
		throw new CommandError("The bridge did not take all traffic.");
	await waitUntilServing(origin, bridge);
	await waitUntilReady(origin);
	const names = plainSecretNames(versionBindings(app, bridge));
	step(
		`2b. Deleting ${names.join(", ")} in one request; sign-in fails until 2c`
	);
	await bulkDelete(app, names);
	step("2c. Deploying the Store-based Worker");
	const deployed = await stream(
		"pnpm",
		wrangler("deploy", "--config", BUILT_CONFIG)
	);
	if (deployed.status !== 0)
		throw new CommandError(
			`The Store-based deploy failed after the plain secrets were deleted: sign-in is down. Fix the cause and run \`pnpm exec wrangler deploy --config ${BUILT_CONFIG}\`, or restore sign-in on the bridge at once (docs/DEPLOYMENT_GUIDE.md, "Switching a Worker that already has plain secrets").`
		);
}

async function removeLeftoverPlain(app: App): Promise<void> {
	const current = servingVersion(app);
	const left =
		current === null ? [] : plainSecretNames(versionBindings(app, current));
	if (left.length === 0) return;
	step(`3. Deleting plain secrets left on the Worker: ${left.join(", ")}`);
	await bulkDelete(app, left);
}

// Every check is anonymous: readiness lists required secrets that did not
// resolve, and Better Auth's get-session answers 200 (null session) only once
// auth is constructed, which requireSecret refuses without
// BETTER_AUTH_SECRET. Probes that need a signed-in user prove nothing here.
async function verify(app: App, origin: string, previous: string | null) {
	step("Verifying production (anonymous probes)");
	const version = servingVersion(app);
	if (version === null || version === previous)
		throw new CommandError("No new version serves all traffic.");
	await waitUntilServing(origin, version);
	const bindings = versionBindings(app, version);
	const verdict = storeBindingsVerdict(app.entries, bindings);
	const plain = plainSecretNames(bindings);
	const [ready, session, health] = await Promise.all(
		["/api/readiness", "/api/auth/get-session", "/api/health"].map(
			(route) =>
				probe(`${origin}${route}`).catch((error: unknown) => {
					throw new CommandError(
						`GET ${origin}${route} failed: ${describe(error)}`
					);
				})
		)
	);
	if (ready === undefined || session === undefined || health === undefined)
		throw new CommandError("A verification probe returned nothing.");
	const problems = [
		...(verdict.kind === "store" ? [] : verdict.problems),
		...(plain.length > 0
			? [`plain secrets remain: ${plain.join(", ")}`]
			: []),
		readinessProblem(ready.status, ready.body),
		session.status === 200
			? null
			: `/api/auth/get-session answered ${session.status}: BETTER_AUTH_SECRET did not resolve`,
		app.entries.some((entry) => entry.binding === "TURRET_SIGNING_KEY")
			? turretProblem(health.body)
			: null,
	].filter((problem) => problem !== null);
	if (problems.length > 0)
		throw new CommandError(
			`Production ${version} is not switched:\n  ${problems.join("\n  ")}`
		);
	say(
		`\nSwitched: ${app.worker} ${version} reads every secret from Secrets Store and has no plain secrets; readiness 200, get-session 200.\nNext: sign in, then deploy through Void as usual (pnpm run deploy or pnpm ship).`
	);
}

async function main(options: SecretsSwitchOptions): Promise<void> {
	assertCredentials();
	if (!options.execute) say("Dry run: reads and a local build only.");
	const app = await loadApp();
	switch (options.phase) {
		case "store":
			return storePhase(app, options);
		case "create-secrets":
			return createSecretsPhase(app, options);
		case "switch":
			return switchPhase(app, options);
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: SECRETS_SWITCH_USAGE,
		parse: () => parseSecretsSwitchOptions(process.argv.slice(2)),
		run: main,
	});
