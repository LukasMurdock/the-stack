// Void's public inference provisions one D1 database. The Stack has two, so it
// reuses Void's own provisioning engine for each declared database instead of
// implementing Cloudflare calls. The engine is internal: its bundler emits
// hashed chunk files whose exports are renamed to letters, as in
// `export { provisionCloudflareResources as g };`. This module finds each
// internal by its real name in the chunks' export statements, and refuses any
// Void version that has not been validated against these call sites.

import {
	closeSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

// Upgrading Void means comparing the internals below between versions (see
// AGENTS.md), running `pnpm test:tooling` and `pnpm check:deploy`, then adding
// the version here.
export const VALIDATED_VOID_VERSIONS: readonly string[] = ["1.1.11"];

// Void 1.1.11 ships 208 chunks; its longest export statement is 1,763 bytes.
export const CHUNK_COUNT_MAX = 2_000;
export const EXPORT_TAIL_BYTES = 16_384;
export const EXPORT_SPECIFIERS_MAX = 512;

const SPECIFIER = /^([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?$/;
const DEFINITION = /^export \{ (.+) \};$/;
const REEXPORT = /^export \{ .+ \} from "[^"]+";$/;
const EXPORT_KEYWORD = /^export\b/;

// Names a chunk declares itself, mapped to the key it exports them under.
// Re-exports (`export { g as name } from "./other.mjs"`) declare nothing.
export type ChunkExports = ReadonlyMap<string, string>;

export type ChunkSource = {
	readonly fileName: string;
	readonly lastLine: string;
};

export type ResolvedExport = {
	readonly fileName: string;
	readonly exportKey: string;
};

// Parses a chunk's final line. Only lines that start with `export` must be a
// well-formed export statement; any other final line declares no exports.
export function parseChunkExports(chunk: ChunkSource): ChunkExports {
	const exports = new Map<string, string>();
	const line = chunk.lastLine.trim();
	if (!EXPORT_KEYWORD.test(line)) return exports;
	if (REEXPORT.test(line) || line === "export {};") return exports;
	const match = DEFINITION.exec(line);
	const list = match?.[1];
	if (list === undefined)
		throw new Error(
			`${chunk.fileName}: unrecognized export statement: ${line.slice(0, 120)}`
		);
	const specifiers = list.split(", ");
	if (specifiers.length > EXPORT_SPECIFIERS_MAX)
		throw new Error(
			`${chunk.fileName}: ${specifiers.length} exports exceed EXPORT_SPECIFIERS_MAX (${EXPORT_SPECIFIERS_MAX}).`
		);
	for (const specifier of specifiers) {
		const parts = SPECIFIER.exec(specifier);
		const local = parts?.[1];
		if (local === undefined)
			throw new Error(
				`${chunk.fileName}: malformed export specifier "${specifier}".`
			);
		// Exporting one binding under two keys is legal; either key works.
		if (!exports.has(local)) exports.set(local, parts?.[2] ?? local);
	}
	return exports;
}

export type ExportIndex = ReadonlyMap<string, readonly ResolvedExport[]>;

// Every declared name across the chunks, with each chunk that declares it.
export function indexChunkExports(chunks: readonly ChunkSource[]): ExportIndex {
	const index = new Map<string, ResolvedExport[]>();
	for (const chunk of chunks)
		for (const [name, exportKey] of parseChunkExports(chunk)) {
			const found = index.get(name) ?? [];
			found.push({ fileName: chunk.fileName, exportKey });
			index.set(name, found);
		}
	return index;
}

// The one chunk that declares `name`. Zero or several matches mean the bundle
// changed shape, so the adapter must be validated again.
export function resolveExport(
	index: ExportIndex,
	name: string
): ResolvedExport {
	const matches = index.get(name) ?? [];
	const [match] = matches;
	if (match === undefined) throw new Error(`No Void chunk exports ${name}.`);
	if (matches.length > 1)
		throw new Error(
			`Several Void chunks export ${name}: ${matches.map((found) => found.fileName).join(", ")}.`
		);
	return match;
}

// The final line of a file, read from at most EXPORT_TAIL_BYTES at its end.
function readLastLine(path: string): string {
	const fd = openSync(path, "r");
	try {
		const sizeBytes = fstatSync(fd).size;
		const tailBytes = Math.min(sizeBytes, EXPORT_TAIL_BYTES);
		const buffer = Buffer.alloc(tailBytes);
		readSync(fd, buffer, 0, tailBytes, sizeBytes - tailBytes);
		const text = buffer.toString("utf8").trimEnd();
		const start = text.lastIndexOf("\n");
		if (start === -1 && tailBytes < sizeBytes)
			throw new Error(
				`${path}: final line exceeds EXPORT_TAIL_BYTES (${EXPORT_TAIL_BYTES}).`
			);
		return text.slice(start + 1);
	} finally {
		closeSync(fd);
	}
}

// Every top-level dist/*.mjs chunk; entry directories (cli/, runtime/) do not
// hold the deploy internals.
export function readChunks(distUrl: URL): ChunkSource[] {
	const fileNames = readdirSync(distUrl)
		.filter((fileName) => fileName.endsWith(".mjs"))
		.sort();
	if (fileNames.length > CHUNK_COUNT_MAX)
		throw new Error(
			`${fileNames.length} Void chunks exceed CHUNK_COUNT_MAX (${CHUNK_COUNT_MAX}).`
		);
	return fileNames.map((fileName) => ({
		fileName,
		lastLine: readLastLine(fileURLToPath(new URL(fileName, distUrl))),
	}));
}

const packageJsonSchema = z.object({ version: z.string() });

export type VoidProvisioningPlan = {
	readonly d1?: {
		readonly binding: string;
		readonly name: string;
		readonly migrationsDir: string;
	};
	readonly kvNamespaces: readonly {
		readonly binding: string;
		readonly title: string;
	}[];
	readonly queues: readonly string[];
	readonly r2?: { readonly binding: string; readonly bucketName: string };
};

export type VoidProvisioning = {
	readonly version: string;
	// Creates or adopts the plan's resources, writes their IDs into the
	// materialized config after each one, and records them in void.lock.json.
	readonly provisionCloudflareResources: (
		root: string,
		configPath: string,
		plan: VoidProvisioningPlan,
		options: Readonly<Record<string, unknown>>
	) => Promise<{
		readonly resources: readonly { readonly action: string }[];
	}>;
	// Writes .void-wrangler.jsonc from void.config.ts merged with
	// void.lock.json and returns its path.
	readonly materializeCloudflareConfig: (root: string) => string;
	// Records the materialized config's resolved values in void.lock.json.
	readonly persistCloudflareConfig: (root: string) => void;
};

async function importValue(
	distUrl: URL,
	index: ExportIndex,
	name: string
): Promise<{ readonly value: unknown; readonly source: string }> {
	const { fileName, exportKey } = resolveExport(index, name);
	const namespace: Record<string, unknown> = await import(
		new URL(fileName, distUrl).href
	);
	return {
		value: namespace[exportKey],
		source: `${fileName} exports ${name} as ${exportKey}`,
	};
}

async function importInternal(
	distUrl: URL,
	index: ExportIndex,
	name: string
): Promise<unknown> {
	const { value, source } = await importValue(distUrl, index, name);
	if (typeof value !== "function")
		throw new Error(`${source}, but it is not a function.`);
	return value;
}

async function loadInternals(
	distUrl: URL
): Promise<Omit<VoidProvisioning, "version">> {
	const index = indexChunkExports(readChunks(distUrl));
	const provision = await importInternal(
		distUrl,
		index,
		"provisionCloudflareResources"
	);
	const materialize = await importInternal(
		distUrl,
		index,
		"materializeCloudflareConfig"
	);
	const persist = await importInternal(
		distUrl,
		index,
		"persistCloudflareConfig"
	);
	return {
		// SAFETY: a function, checked by importInternal; its signature was
		// compared for every version in VALIDATED_VOID_VERSIONS.
		provisionCloudflareResources:
			provision as VoidProvisioning["provisionCloudflareResources"],
		// SAFETY: as above.
		materializeCloudflareConfig:
			materialize as VoidProvisioning["materializeCloudflareConfig"],
		// SAFETY: as above.
		persistCloudflareConfig:
			persist as VoidProvisioning["persistCloudflareConfig"],
	};
}

// The installed version, refused unless it is in VALIDATED_VOID_VERSIONS.
function readValidatedVersion(entryUrl: string): string {
	const { version } = packageJsonSchema.parse(
		JSON.parse(readFileSync(new URL("../package.json", entryUrl), "utf8"))
	);
	if (!VALIDATED_VOID_VERSIONS.includes(version))
		throw new Error(
			`Void ${version} has not been validated with scripts/lib/void-cloudflare.ts (validated: ${VALIDATED_VOID_VERSIONS.join(", ")}). Compare the internals it loads by name with the validated version, run pnpm test:tooling and pnpm check:deploy, then add ${version} to VALIDATED_VOID_VERSIONS.`
		);
	return version;
}

async function withVersionContext<T>(
	version: string,
	load: () => Promise<T>
): Promise<T> {
	try {
		return await load();
	} catch (error: unknown) {
		throw new Error(
			`Void ${version}: ${error instanceof Error ? error.message : String(error)} Validate scripts/lib/void-cloudflare.ts against this version.`,
			{ cause: error }
		);
	}
}

// `entryUrl` is the package's main module (dist/index.mjs); tests pass a fake.
export async function loadVoidProvisioning(
	entryUrl: string = import.meta.resolve("void")
): Promise<VoidProvisioning> {
	const version = readValidatedVersion(entryUrl);
	const internals = await withVersionContext(version, () =>
		loadInternals(new URL("./", entryUrl))
	);
	return { version, ...internals };
}

// --- Deploy artifact --------------------------------------------------------
// `void deploy --platform cloudflare` prepares an Astro Worker in
// prepareCloudflareFrameworkArtifact, which Void does not export, from the
// internals below; scripts/testing/deploy-artifact.ts repeats its steps. The
// public packages are Void's own dependencies, resolved from its directory.

export const VOID_DEPLOY_INTERNALS = [
	"readConfig",
	"detectFramework",
	"FRAMEWORK_PRESETS",
	"analyzeApplicationSync",
	"collectRevalidate",
	"hasRevalidate",
	"selectNativeVersionMetadataBinding",
	"generateDeployWrapperIfNeeded",
	"prepareCfFrameworkBuildOutput",
	"scrubWranglerAuthCredentials",
	"materializeCloudflareConfig",
] as const;

export const VOID_DEPLOY_PACKAGES = {
	"@void/deploy-cloudflare": [
		"parseRootWranglerConfig",
		"writeCloudflareFrameworkDeployConfig",
	],
	"@cloudflare/build-output-utils": ["readBuildOutput", "getWorkerBundleDir"],
} as const;

type Loaded = ReadonlyMap<string, unknown>;

// Values are parsed by the caller: these types only say how to call each
// internal, as its validated version takes it, and return unknown.
export type VoidDeployInternals = {
	readonly version: string;
	readonly readConfig: (root: string) => unknown;
	readonly detectFramework: (root: string) => unknown;
	readonly frameworkPresets: unknown;
	readonly analyzeApplicationSync: (
		root: string,
		options: { readonly config: unknown; readonly environment: "prod" }
	) => unknown;
	readonly collectRevalidate: (config: unknown, routes: null) => unknown;
	readonly hasRevalidate: (revalidate: unknown) => unknown;
	readonly selectNativeVersionMetadataBinding: (
		rootConfig: unknown,
		options: {
			readonly nativeBuild: true;
			readonly preserveBindings: false;
		}
	) => unknown;
	readonly generateDeployWrapperIfNeeded: (
		root: string,
		workerDir: string,
		workerMain: string,
		features: Readonly<Record<string, unknown>>
	) => Promise<unknown>;
	readonly prepareCfFrameworkBuildOutput: (options: {
		readonly projectRoot: string;
		readonly configPath: string;
		readonly accountId: string | undefined;
	}) => Promise<unknown>;
	// Deletes every Cloudflare credential from env, in place.
	readonly scrubWranglerAuthCredentials: (env: NodeJS.ProcessEnv) => unknown;
	readonly materializeCloudflareConfig: (root: string) => string;
	readonly parseRootWranglerConfig: (configPath: string) => unknown;
	readonly writeCloudflareFrameworkDeployConfig: (
		options: Readonly<Record<string, unknown>>
	) => unknown;
	readonly readBuildOutput: (directory: string) => Promise<unknown>;
	readonly getWorkerBundleDir: (directory: string) => string;
};

function loaded<T>(values: Loaded, name: string): T {
	const value = values.get(name);
	if (typeof value !== "function")
		throw new Error(`${name} was not loaded as a function.`);
	// SAFETY: a function, checked above and when imported; T is how the
	// version in VALIDATED_VOID_VERSIONS takes it, compared by hand.
	return value as T;
}

function deployInternals(
	values: Loaded
): Omit<VoidDeployInternals, "version" | "frameworkPresets"> {
	return {
		readConfig: loaded(values, "readConfig"),
		detectFramework: loaded(values, "detectFramework"),
		analyzeApplicationSync: loaded(values, "analyzeApplicationSync"),
		collectRevalidate: loaded(values, "collectRevalidate"),
		hasRevalidate: loaded(values, "hasRevalidate"),
		selectNativeVersionMetadataBinding: loaded(
			values,
			"selectNativeVersionMetadataBinding"
		),
		generateDeployWrapperIfNeeded: loaded(
			values,
			"generateDeployWrapperIfNeeded"
		),
		prepareCfFrameworkBuildOutput: loaded(
			values,
			"prepareCfFrameworkBuildOutput"
		),
		scrubWranglerAuthCredentials: loaded(
			values,
			"scrubWranglerAuthCredentials"
		),
		materializeCloudflareConfig: loaded(
			values,
			"materializeCloudflareConfig"
		),
		parseRootWranglerConfig: loaded(values, "parseRootWranglerConfig"),
		writeCloudflareFrameworkDeployConfig: loaded(
			values,
			"writeCloudflareFrameworkDeployConfig"
		),
		readBuildOutput: loaded(values, "readBuildOutput"),
		getWorkerBundleDir: loaded(values, "getWorkerBundleDir"),
	};
}

const packageEntrySchema = z.object({
	exports: z.object({ ".": z.object({ import: z.string() }) }),
});

// Void's dependencies export only an `import` condition, so `require.resolve`
// cannot find them; findPackageJSON walks node_modules from Void's directory.
async function importVoidDependency(
	entryUrl: string,
	name: string
): Promise<Record<string, unknown>> {
	const packageJsonPath = findPackageJSON(name, entryUrl);
	if (packageJsonPath === undefined)
		throw new Error(`Void's dependency ${name} is not installed.`);
	const { exports } = packageEntrySchema.parse(
		JSON.parse(readFileSync(packageJsonPath, "utf8"))
	);
	const moduleUrl = new URL(
		exports["."].import,
		pathToFileURL(packageJsonPath)
	);
	return import(moduleUrl.href);
}

async function loadDeployInternals(
	entryUrl: string
): Promise<Omit<VoidDeployInternals, "version">> {
	const distUrl = new URL("./", entryUrl);
	const index = indexChunkExports(readChunks(distUrl));
	const values = new Map<string, unknown>();
	for (const name of VOID_DEPLOY_INTERNALS) {
		const { value, source } = await importValue(distUrl, index, name);
		if (name !== "FRAMEWORK_PRESETS" && typeof value !== "function")
			throw new Error(`${source}, but it is not a function.`);
		values.set(name, value);
	}
	for (const [packageName, names] of Object.entries(VOID_DEPLOY_PACKAGES)) {
		const namespace = await importVoidDependency(entryUrl, packageName);
		for (const name of names) {
			if (typeof namespace[name] !== "function")
				throw new Error(
					`${packageName} does not export a function ${name}.`
				);
			values.set(name, namespace[name]);
		}
	}
	return {
		...deployInternals(values),
		frameworkPresets: values.get("FRAMEWORK_PRESETS"),
	};
}

export async function loadVoidDeployInternals(
	entryUrl: string = import.meta.resolve("void")
): Promise<VoidDeployInternals> {
	const version = readValidatedVersion(entryUrl);
	const internals = await withVersionContext(version, () =>
		loadDeployInternals(entryUrl)
	);
	return { version, ...internals };
}
