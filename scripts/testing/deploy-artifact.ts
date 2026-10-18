// `pnpm check:deploy` builds the Worker `void deploy --platform cloudflare`
// would publish, offline: no credentials, no account and no network. It runs
// the app's build the way Void's buildCloudflareWorker does, then repeats
// prepareCloudflareFrameworkArtifact (the cron/readiness wrapper and deploy
// config, which Void does not export) and prepareCfFrameworkBuildOutput (the
// re-bundle Void hands to Cloudflare) through Void's own internals, loaded by
// name in scripts/lib/void-cloudflare.ts. It then checks the result: the main
// module exists, every relative import resolves inside the bundle, and the
// bindings and cron schedules are the ones the config declares.
//
// It assumes a first deploy (no existing Worker whose bindings Void would
// preserve) and skips what needs an account: the store's secrets and Void's
// email setup. It refuses plain Worker secrets (scripts/lib/secrets-store.ts)
// and a config that leaves routes, workers_dev or preview_urls to Void's
// inheritance (scripts/lib/worker-traffic.ts).
// Afterwards the generated config and the deploy pointer are restored, so only
// dist/ shows that it ran.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "../lib/cli.ts";
import {
	loadVoidDeployInternals,
	type VoidDeployInternals,
} from "../lib/void-cloudflare.ts";
import { buildOutputDrift, readVoidLock } from "../lib/void-lock.ts";
import {
	artifactSecretProblems,
	secretsConfigProblems,
} from "../lib/secrets-store.ts";
import { trafficConfigProblems } from "../lib/worker-traffic.ts";

// A cold production build on a loaded machine.
export const DEPLOY_BUILD_TIMEOUT_MS = 20 * 60_000;
// The template's Worker bundles to about 40 modules.
export const ARTIFACT_MODULES_MAX = 2_000;
export const MODULE_BYTES_MAX = 64 * 1_048_576;
// Void's markers for its own deploy build (env-BJjULvL0, version-metadata).
const DEPLOY_BUILD_ENV = "VOID_CLOUDFLARE_DEPLOY_BUILD";
const PRESERVE_BINDINGS_ENV = "VOID_CLOUDFLARE_PRESERVE_BINDINGS";
// The Cloudflare Vite plugin's deploy redirect (Void's deployPointerPath).
const DEPLOY_POINTER = path.join(".wrangler", "deploy", "config.json");

export const DEPLOY_ARTIFACT_USAGE = `Usage: pnpm check:deploy

Builds the Worker \`void deploy --platform cloudflare\` would publish, without
credentials or network, and checks it: main module present, every relative
import resolvable, bindings and cron schedules as configured. Runs the app's
deploy build (void.config.ts inference.build) first; leaves the result in dist/.

  -h, --help  Show this help.`;

export type DeployArtifactOptions = Readonly<Record<string, never>>;

export function parseDeployArtifactOptions(
	argv: readonly string[]
): Command<DeployArtifactOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	return { kind: "run", options: {} };
}

// --- Configuration -----------------------------------------------------------

// Wrangler fields whose entries are bindings: field -> [name key, type in the
// cf Build Output]. Anything in UNCHECKED_BINDING_FIELDS stops the check, so a
// new kind of binding is added here rather than silently ignored.
const BINDING_LISTS = {
	d1_databases: ["binding", "d1"],
	kv_namespaces: ["binding", "kv"],
	r2_buckets: ["binding", "r2"],
	analytics_engine_datasets: ["binding", "analytics-engine-dataset"],
	flagship: ["binding", "flagship"],
	send_email: ["name", "send-email"],
	secrets_store_secrets: ["binding", "secrets-store-secret"],
} as const;
const BINDING_OBJECTS = {
	assets: "assets",
	version_metadata: "version-metadata",
	analytics: "analytics",
	ai: "ai",
	images: "images",
	browser: "browser",
} as const;
export const UNCHECKED_BINDING_FIELDS = [
	"services",
	"queues",
	"durable_objects",
	"hyperdrive",
	"vectorize",
	"mtls_certificates",
	"dispatch_namespaces",
	"workflows",
	"pipelines",
	"ratelimits",
	"worker_loaders",
	"unsafe",
	"logfwdr",
	"vpc_services",
	"media",
	"ai_search",
] as const;

const bindingEntry = z.record(z.string(), z.unknown());
const configSchema = z.looseObject({
	name: z.string().min(1),
	account_id: z.string().optional(),
	compatibility_date: z.string().min(1),
	vars: z.record(z.string(), z.unknown()).optional(),
	triggers: z
		.object({ crons: z.array(z.string()) })
		.partial()
		.optional(),
});

export type ExpectedArtifact = {
	// Binding name -> its type in the cf Build Output.
	readonly bindings: ReadonlyMap<string, string>;
	readonly crons: readonly string[];
};

function bindingName(entry: unknown, key: string, field: string): string {
	const name = bindingEntry.parse(entry)[key];
	if (typeof name !== "string" || name === "")
		throw new CommandError(`${field} has an entry without a ${key}.`);
	return name;
}

function addBinding(
	bindings: Map<string, string>,
	name: string,
	type: string
): void {
	if (bindings.has(name))
		throw new CommandError(`The config declares ${name} twice.`);
	bindings.set(name, type);
}

// The bindings and schedules the generated Cloudflare config declares.
export function expectedFromConfig(config: unknown): ExpectedArtifact {
	const record = z.record(z.string(), z.unknown()).parse(config);
	for (const field of UNCHECKED_BINDING_FIELDS)
		if (record[field] !== undefined)
			throw new CommandError(
				`The config declares ${field}, which pnpm check:deploy cannot compare yet; add it to BINDING_LISTS in scripts/testing/deploy-artifact.ts.`
			);
	const parsed = configSchema.parse(config);
	const bindings = new Map<string, string>();
	for (const [name, value] of Object.entries(parsed.vars ?? {}))
		addBinding(bindings, name, typeof value === "string" ? "text" : "json");
	for (const [field, [key, type]] of Object.entries(BINDING_LISTS))
		for (const entry of z.array(z.unknown()).parse(record[field] ?? []))
			addBinding(bindings, bindingName(entry, key, field), type);
	for (const [field, type] of Object.entries(BINDING_OBJECTS))
		if (record[field] !== undefined)
			addBinding(
				bindings,
				bindingName(record[field], "binding", field),
				type
			);
	return { bindings, crons: [...(parsed.triggers?.crons ?? [])].sort() };
}

const voidConfigSchema = z.looseObject({
	inference: z
		.looseObject({ build: z.string().min(1).optional() })
		.optional(),
	worker: z
		.looseObject({ compatibility_date: z.string().optional() })
		.optional(),
	routing: z
		.looseObject({ revalidateQueryAllowlist: z.unknown().optional() })
		.optional(),
});
type VoidConfig = z.infer<typeof voidConfigSchema>;

const frameworkSchema = z.looseObject({ name: z.string().min(1) });
const presetSchema = z.looseObject({
	cloudflareArtifact: z.string(),
	cloudflareCompatibilityFlags: z.array(z.string()).optional(),
	buildCommand: z.string(),
	workerDir: z.string().min(1),
	workerMain: z.string().min(1),
	assetsDir: z.string().min(1),
});
type Preset = z.infer<typeof presetSchema>;

const analysisSchema = z.looseObject({
	jobs: z.array(z.looseObject({ crons: z.array(z.string()) })),
	queues: z.array(z.unknown()),
	dialect: z.string(),
	bindings: z.looseObject({ needsAI: z.boolean() }),
});

function frameworkPreset(sdk: VoidDeployInternals, root: string): Preset {
	const detected = sdk.detectFramework(root);
	if (detected === null || detected === undefined)
		throw new CommandError("Void detects no framework in this project.");
	const { name } = frameworkSchema.parse(detected);
	const presets = z
		.record(z.string(), z.unknown())
		.parse(sdk.frameworkPresets);
	const preset = presetSchema.parse(presets[name]);
	if (preset.cloudflareArtifact !== "worker-output")
		throw new CommandError(
			`Void deploys ${name} as "${preset.cloudflareArtifact}"; pnpm check:deploy covers "worker-output" frameworks (Astro).`
		);
	return preset;
}

// --- The deploy steps -------------------------------------------------------

function runDeployBuild(
	sdk: VoidDeployInternals,
	root: string,
	command: string
): void {
	const env: NodeJS.ProcessEnv = { ...process.env };
	sdk.scrubWranglerAuthCredentials(env);
	delete env[PRESERVE_BINDINGS_ENV];
	env[DEPLOY_BUILD_ENV] = "1";
	env.NODE_ENV = "production";
	process.stdout.write(`-> ${command} (as void deploy builds it)\n`);
	const result = spawnSync(command, {
		cwd: root,
		env,
		shell: true,
		stdio: "inherit",
		timeout: DEPLOY_BUILD_TIMEOUT_MS,
	});
	if (result.error !== undefined)
		throw new CommandError(
			`The deploy build did not run: ${result.error.message}`,
			{
				cause: result.error,
			}
		);
	if (result.status !== 0)
		throw new CommandError(
			`The deploy build (${command}) failed (exit ${result.status ?? result.signal}).`
		);
}

type ArtifactInput = {
	readonly root: string;
	readonly configPath: string;
	readonly voidConfig: VoidConfig;
	readonly preset: Preset;
};

// Void's prepareCloudflareFrameworkArtifact for a first deploy, step by step.
async function prepareFrameworkArtifact(
	sdk: VoidDeployInternals,
	input: ArtifactInput
): Promise<void> {
	const { root, configPath, voidConfig, preset } = input;
	const workerMain = path.join(root, preset.workerDir, preset.workerMain);
	const assetsDirectory = path.join(root, preset.assetsDir);
	if (!existsSync(workerMain))
		throw new CommandError(`The build did not emit ${workerMain}.`);
	if (!existsSync(assetsDirectory))
		throw new CommandError(`The build did not emit ${assetsDirectory}.`);
	const analysis = analysisSchema.parse(
		sdk.analyzeApplicationSync(root, {
			config: sdk.readConfig(root),
			environment: "prod",
		})
	);
	if (analysis.bindings.needsAI)
		throw new CommandError(
			"The app uses Workers AI, which pnpm check:deploy does not configure yet."
		);
	const revalidate = sdk.collectRevalidate(sdk.readConfig(root), null);
	const rootConfig = sdk.parseRootWranglerConfig(configPath);
	const versionMetadataBinding = sdk.selectNativeVersionMetadataBinding(
		rootConfig,
		{ nativeBuild: true, preserveBindings: false }
	);
	await sdk.generateDeployWrapperIfNeeded(
		root,
		path.join(root, preset.workerDir),
		preset.workerMain,
		{
			crons: analysis.jobs,
			queues: analysis.queues,
			hasMigrations: false,
			migrationDialect: analysis.dialect,
			readiness: true,
			versionMetadataBinding,
			...(sdk.hasRevalidate(revalidate) === true && {
				isr: {
					revalidate,
					queryAllowlist:
						voidConfig.routing?.revalidateQueryAllowlist,
				},
			}),
		}
	);
	const config = configSchema.parse(rootConfig);
	sdk.writeCloudflareFrameworkDeployConfig({
		configPath,
		deployPointerPath: path.join(root, DEPLOY_POINTER),
		name: config.name,
		accountId: config.account_id,
		main: path.relative(path.dirname(configPath), workerMain),
		assetsDirectory: path.relative(
			path.dirname(configPath),
			assetsDirectory
		),
		compatibilityDate:
			voidConfig.worker?.compatibility_date ?? config.compatibility_date,
		compatibilityFlags:
			analysis.dialect === "sqlite"
				? preset.cloudflareCompatibilityFlags
				: [
						...(preset.cloudflareCompatibilityFlags ?? []),
						"nodejs_compat",
					],
		crons: [...new Set(analysis.jobs.flatMap((job) => job.crons))],
		requiredSecrets: [],
		versionMetadataBinding,
	});
}

// --- The artifact ------------------------------------------------------------

const preparedSchema = z.object({
	directory: z.string(),
	dispose: z.custom<() => Promise<void>>(
		(value) => typeof value === "function"
	),
});

const workerOutputSchema = z.looseObject({
	workers: z.looseObject({
		default: z.looseObject({
			config: z.looseObject({
				env: z
					.record(z.string(), z.looseObject({ type: z.string() }))
					.optional(),
				triggers: z
					.array(
						z.looseObject({
							type: z.string(),
							schedule: z.string().optional(),
						})
					)
					.optional(),
				manifest: z.looseObject({
					mainModule: z.string(),
					modules: z.record(
						z.string(),
						z.looseObject({ type: z.string() })
					),
				}),
			}),
		}),
	}),
});

export type ArtifactModule = {
	readonly type: string;
	// The text of an ES module; null for other module types.
	readonly source: string | null;
};

export type Artifact = {
	readonly mainModule: string;
	readonly modules: ReadonlyMap<string, ArtifactModule>;
	// Binding name -> type.
	readonly bindings: ReadonlyMap<string, string>;
	readonly schedules: readonly string[];
};

function readModuleSource(bundleDirectory: string, name: string): string {
	const file = path.join(bundleDirectory, name);
	const text = readFileSync(file, "utf8");
	if (Buffer.byteLength(text) > MODULE_BYTES_MAX)
		throw new CommandError(
			`${name} exceeds MODULE_BYTES_MAX (${MODULE_BYTES_MAX} bytes).`
		);
	return text;
}

function readArtifact(output: unknown, bundleDirectory: string): Artifact {
	const { config } = workerOutputSchema.parse(output).workers.default;
	const names = Object.keys(config.manifest.modules);
	if (names.length > ARTIFACT_MODULES_MAX)
		throw new CommandError(
			`${names.length} modules exceed ARTIFACT_MODULES_MAX (${ARTIFACT_MODULES_MAX}).`
		);
	const modules = new Map<string, ArtifactModule>();
	for (const [name, { type }] of Object.entries(config.manifest.modules))
		modules.set(name, {
			type,
			source:
				type === "esm" ? readModuleSource(bundleDirectory, name) : null,
		});
	const bindings = new Map<string, string>();
	for (const [name, { type }] of Object.entries(config.env ?? {}))
		bindings.set(name, type);
	const schedules: string[] = [];
	for (const trigger of config.triggers ?? [])
		if (trigger.type === "scheduled" && trigger.schedule !== undefined)
			schedules.push(trigger.schedule);
	return {
		mainModule: config.manifest.mainModule,
		modules,
		bindings,
		schedules: schedules.sort(),
	};
}

// Static, re-export and dynamic import specifiers that start with ./ or ../.
// TypeScript's pre-processor scans tokens, so specifiers quoted inside
// strings and comments (React's error text names './MyComponent') do not count.
export function relativeImports(source: string): readonly string[] {
	const { importedFiles } = ts.preProcessFile(source, true, true);
	const found = new Set<string>();
	for (const { fileName } of importedFiles)
		if (fileName.startsWith("./") || fileName.startsWith("../"))
			found.add(fileName);
	return [...found];
}

function unresolvedImports(artifact: Artifact): readonly string[] {
	const problems: string[] = [];
	for (const [name, module] of artifact.modules) {
		if (module.source === null) continue;
		for (const specifier of relativeImports(module.source)) {
			const target = path.posix.normalize(
				path.posix.join(path.posix.dirname(name), specifier)
			);
			if (!artifact.modules.has(target))
				problems.push(
					`${name} imports ${specifier}, which is not in the bundle.`
				);
		}
	}
	return problems;
}

function bindingProblems(
	actual: ReadonlyMap<string, string>,
	expected: ReadonlyMap<string, string>
): readonly string[] {
	const problems: string[] = [];
	for (const [name, type] of expected) {
		const found = actual.get(name);
		if (found === undefined)
			problems.push(`The Worker is missing the ${type} binding ${name}.`);
		else if (found !== type)
			problems.push(
				`${name} is a ${found} binding; the config declares ${type}.`
			);
	}
	for (const [name, type] of actual)
		if (!expected.has(name))
			problems.push(
				`The Worker has a ${type} binding ${name} the config does not declare.`
			);
	return problems;
}

// Every reason the artifact would not deploy as configured; empty means none.
export function verifyArtifact(
	artifact: Artifact,
	expected: ExpectedArtifact
): readonly string[] {
	const problems: string[] = [];
	if (!artifact.modules.has(artifact.mainModule))
		problems.push(
			`The main module ${artifact.mainModule} is not in the bundle.`
		);
	problems.push(...unresolvedImports(artifact));
	problems.push(...bindingProblems(artifact.bindings, expected.bindings));
	problems.push(...artifactSecretProblems(artifact.bindings));
	const schedules = artifact.schedules.join(", ");
	const crons = expected.crons.join(", ");
	if (schedules !== crons)
		problems.push(
			`The Worker runs on [${schedules}]; the config declares triggers.crons [${crons}]. Void publishes the schedules of crons/*.ts, so keep both the same.`
		);
	return problems;
}

// --- Orchestration -----------------------------------------------------------

function storeBindings(artifact: Artifact): readonly string[] {
	return [...artifact.bindings]
		.filter(([, type]) => type === "secrets-store-secret")
		.map(([name]) => name)
		.sort();
}

function assertLockNormalized(root: string): void {
	const lock = readVoidLock(root);
	if (lock === null) return;
	const drift = buildOutputDrift(lock);
	if (drift.length > 0)
		throw new CommandError(
			`void.lock.json records the last build's output for ${drift.join(", ")}, so the next build would use it as its source. pnpm run deploy restores the authored values (scripts/lib/void-lock.ts normalizeVoidLock); commit the normalized lock.`
		);
}

async function buildArtifact(
	sdk: VoidDeployInternals,
	input: ArtifactInput
): Promise<Artifact> {
	await prepareFrameworkArtifact(sdk, input);
	const config = configSchema.parse(
		sdk.parseRootWranglerConfig(input.configPath)
	);
	let output: unknown;
	try {
		output = await sdk.prepareCfFrameworkBuildOutput({
			projectRoot: input.root,
			configPath: input.configPath,
			accountId: config.account_id,
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CommandError(
			`Void could not re-bundle the Worker for Cloudflare (prepareCfFrameworkBuildOutput):\n${message}${cronBundleHint(message)}`,
			{ cause: error }
		);
	}
	if (output === null)
		throw new CommandError(
			"Void could not prepare the built Worker for deployment (prepareCfFrameworkBuildOutput returned nothing)."
		);
	const prepared = preparedSchema.parse(output);
	try {
		const built = await sdk.readBuildOutput(prepared.directory);
		return readArtifact(built, sdk.getWorkerBundleDir(prepared.directory));
	} finally {
		await prepared.dispose();
	}
}

// Leaves the pointer the build wrote and the generated config Void would
// materialize, as after a plain build.
async function withRestoredState<T>(
	sdk: VoidDeployInternals,
	root: string,
	run: () => Promise<T>
): Promise<T> {
	const pointer = path.join(root, DEPLOY_POINTER);
	const saved = existsSync(pointer) ? readFileSync(pointer, "utf8") : null;
	try {
		return await run();
	} finally {
		if (saved === null) rmSync(pointer, { force: true });
		else writeFileSync(pointer, saved);
		sdk.materializeCloudflareConfig(root);
	}
}

export async function checkDeployArtifact(
	_options: DeployArtifactOptions
): Promise<void> {
	const root = process.cwd();
	const sdk = await loadVoidDeployInternals();
	assertLockNormalized(root);
	const voidConfig = voidConfigSchema.parse(sdk.readConfig(root));
	const configPath = sdk.materializeCloudflareConfig(root);
	const rootConfig = sdk.parseRootWranglerConfig(configPath);
	// Before the build: a config with plain secrets is refused in seconds.
	const secretProblems = secretsConfigProblems(rootConfig, root);
	if (secretProblems.length > 0)
		throw new CommandError(
			`The production config would deploy plain Worker secrets:\n${secretProblems.map((problem) => `  - ${problem}`).join("\n")}`
		);
	const [trafficProblem] = trafficConfigProblems(rootConfig);
	if (trafficProblem !== undefined) throw new CommandError(trafficProblem);
	const preset = frameworkPreset(sdk, root);
	const expected = expectedFromConfig(rootConfig);
	rmSync(path.join(root, DEPLOY_POINTER), { force: true });
	runDeployBuild(
		sdk,
		root,
		voidConfig.inference?.build ?? preset.buildCommand
	);
	process.stdout.write("-> preparing the Worker as void deploy does\n");
	const artifact = await withRestoredState(sdk, root, () =>
		buildArtifact(sdk, { root, configPath, voidConfig, preset })
	);
	const problems = verifyArtifact(artifact, expected);
	if (problems.length > 0)
		throw new CommandError(
			`The deploy artifact would not deploy as configured:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`
		);
	process.stdout.write(
		`Deploy artifact OK (Void ${sdk.version}): main module ${artifact.mainModule}, ${artifact.modules.size} modules, ${artifact.bindings.size} bindings, crons [${artifact.schedules.join(", ")}], Secrets Store bindings [${storeBindings(artifact).join(", ")}], no plain secrets.\n`
	);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: DEPLOY_ARTIFACT_USAGE,
		parse: () => parseDeployArtifactOptions(process.argv.slice(2)),
		run: checkDeployArtifact,
	});

// Void bundles crons/ separately and copies only that bundle's entry file, so
// a chunk the entry imports is missing from the published Worker.
export function cronBundleHint(message: string): string {
	if (!message.includes("__void_handlers")) return "";
	return (
		"\nA crons/ module's import graph split into chunks, and Void publishes only the entry file. " +
		"Import the job module (src/worker/scheduled-cleanup.ts), not the API Worker or anything that uses a dynamic import()."
	);
}
