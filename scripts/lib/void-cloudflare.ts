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
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Upgrading Void means comparing the internals below between versions (see
// AGENTS.md) and running `pnpm test:tooling`, then adding the version here.
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

async function importInternal(
	distUrl: URL,
	index: ExportIndex,
	name: string
): Promise<unknown> {
	const { fileName, exportKey } = resolveExport(index, name);
	const namespace: Record<string, unknown> = await import(
		new URL(fileName, distUrl).href
	);
	const value = namespace[exportKey];
	if (typeof value !== "function")
		throw new Error(
			`${fileName} exports ${name} as ${exportKey}, but it is not a function.`
		);
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

// `entryUrl` is the package's main module (dist/index.mjs); tests pass a fake.
export async function loadVoidProvisioning(
	entryUrl: string = import.meta.resolve("void")
): Promise<VoidProvisioning> {
	const { version } = packageJsonSchema.parse(
		JSON.parse(readFileSync(new URL("../package.json", entryUrl), "utf8"))
	);
	if (!VALIDATED_VOID_VERSIONS.includes(version))
		throw new Error(
			`Void ${version} has not been validated with scripts/lib/void-cloudflare.ts (validated: ${VALIDATED_VOID_VERSIONS.join(", ")}). Compare provisionCloudflareResources, materializeCloudflareConfig and persistCloudflareConfig with the validated version, run pnpm test:tooling, then add ${version} to VALIDATED_VOID_VERSIONS.`
		);
	try {
		return { version, ...(await loadInternals(new URL("./", entryUrl))) };
	} catch (error: unknown) {
		throw new Error(
			`Void ${version}: ${error instanceof Error ? error.message : String(error)} Validate scripts/lib/void-cloudflare.ts against this version.`,
			{ cause: error }
		);
	}
}
