import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	CHUNK_COUNT_MAX,
	EXPORT_SPECIFIERS_MAX,
	EXPORT_TAIL_BYTES,
	indexChunkExports,
	loadVoidProvisioning,
	parseChunkExports,
	readChunks,
	resolveExport,
	VALIDATED_VOID_VERSIONS,
} from "../../scripts/lib/void-cloudflare.ts";

const parse = (lastLine: string) =>
	Object.fromEntries(parseChunkExports({ fileName: "chunk.mjs", lastLine }));

test("parses a chunk's export map by real name", () => {
	assert.deepEqual(
		parse(
			"export { provisionEnv as _, provisionCloudflareResources as g, isRealD1Id as f };"
		),
		{
			provisionEnv: "_",
			provisionCloudflareResources: "g",
			isRealD1Id: "f",
		}
	);
	// Public entry chunks export names unchanged.
	assert.deepEqual(parse("export { voidPlugin, defineHandler };\n"), {
		voidPlugin: "voidPlugin",
		defineHandler: "defineHandler",
	});
	// One binding under two keys keeps the first; either key is the binding.
	assert.deepEqual(parse("export { a as x, a as y };"), { a: "x" });
});

test("declares nothing for re-exports, empty exports and other final lines", () => {
	assert.deepEqual(
		parse('export { f as isRealD1Id, p as x } from "./provision-B.mjs";'),
		{}
	);
	assert.deepEqual(parse("export {};"), {});
	assert.deepEqual(parse("//#endregion"), {});
	assert.deepEqual(parse("exportedName();"), {});
	assert.deepEqual(parse(""), {});
});

test("rejects malformed export statements", () => {
	for (const line of [
		"export { a as };",
		"export { a b };",
		"export { a as b",
		"export {a as b};",
		"export { a as b, };",
		"export { 1a as b };",
		'export { a as "b c" };',
		"export default foo;",
		'export * from "./x.mjs";',
		"export const a = 1;",
	])
		assert.throws(
			() => parse(line),
			/chunk\.mjs: (unrecognized export statement|malformed export specifier)/,
			line
		);
	const tooMany = Array.from(
		{ length: EXPORT_SPECIFIERS_MAX + 1 },
		(_, i) => `n${i} as k${i}`
	).join(", ");
	assert.throws(
		() => parse(`export { ${tooMany} };`),
		/exceed EXPORT_SPECIFIERS_MAX/
	);
});

test("resolves a name to exactly one chunk", () => {
	const index = indexChunkExports([
		{
			fileName: "cloudflare-config-X.mjs",
			lastLine:
				"export { persistCloudflareConfig as i, materializeCloudflareConfig as r };",
		},
		{
			fileName: "provision-A.mjs",
			lastLine: "export { provisionCloudflareResources as g };",
		},
		// A re-export of the same name is not a second declaration.
		{
			fileName: "provision-B.mjs",
			lastLine:
				'export { g as provisionCloudflareResources } from "./provision-A.mjs";',
		},
		{ fileName: "dup-1.mjs", lastLine: "export { shared as a };" },
		{ fileName: "dup-2.mjs", lastLine: "export { shared as b };" },
	]);
	assert.deepEqual(resolveExport(index, "provisionCloudflareResources"), {
		fileName: "provision-A.mjs",
		exportKey: "g",
	});
	assert.deepEqual(resolveExport(index, "persistCloudflareConfig"), {
		fileName: "cloudflare-config-X.mjs",
		exportKey: "i",
	});
	assert.throws(
		() => resolveExport(index, "missingInternal"),
		/^Error: No Void chunk exports missingInternal\.$/
	);
	assert.throws(
		() => resolveExport(index, "shared"),
		/Several Void chunks export shared: dup-1\.mjs, dup-2\.mjs\./
	);
});

function fakeVoid(
	t: test.TestContext,
	version: string,
	chunks: Record<string, string>
): string {
	const root = mkdtempSync(path.join(tmpdir(), "stack-fake-void-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(path.join(root, "dist"));
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
	writeFileSync(path.join(root, "dist", "index.mjs"), "export {};\n");
	for (const [fileName, source] of Object.entries(chunks))
		writeFileSync(path.join(root, "dist", fileName), source);
	return pathToFileURL(path.join(root, "dist", "index.mjs")).href;
}

const CONFIG_CHUNK = `function materializeCloudflareConfig(root) { return root + "/.void-wrangler.jsonc"; }
function persistCloudflareConfig() {}
export { persistCloudflareConfig as i, materializeCloudflareConfig as r };
`;
const PROVISION_CHUNK = `async function provisionCloudflareResources() { return { resources: [] }; }
export { provisionCloudflareResources as g };
`;
const [validatedVersion = ""] = VALIDATED_VOID_VERSIONS;

test("loads internals from a package by name, whatever the chunk hashes", async (t) => {
	const entry = fakeVoid(t, validatedVersion, {
		"cloudflare-config-Zz9.mjs": CONFIG_CHUNK,
		"provision-Qq1.mjs": PROVISION_CHUNK,
	});
	const sdk = await loadVoidProvisioning(entry);
	assert.equal(
		sdk.materializeCloudflareConfig("/app"),
		"/app/.void-wrangler.jsonc"
	);
	assert.deepEqual(
		await sdk.provisionCloudflareResources(
			"/app",
			"c",
			{ kvNamespaces: [], queues: [] },
			{}
		),
		{ resources: [] }
	);
});

test("refuses unvalidated versions and changed bundles with the fix", async (t) => {
	await assert.rejects(
		loadVoidProvisioning(fakeVoid(t, "99.0.0", {})),
		/Void 99\.0\.0 has not been validated .*add 99\.0\.0 to VALIDATED_VOID_VERSIONS/
	);
	await assert.rejects(
		loadVoidProvisioning(
			fakeVoid(t, validatedVersion, { "c.mjs": CONFIG_CHUNK })
		),
		new RegExp(
			`Void ${validatedVersion}: No Void chunk exports provisionCloudflareResources\\. Validate`
		)
	);
	await assert.rejects(
		loadVoidProvisioning(
			fakeVoid(t, validatedVersion, {
				"c.mjs": CONFIG_CHUNK,
				"p1.mjs": PROVISION_CHUNK,
				"p2.mjs": PROVISION_CHUNK,
			})
		),
		/Several Void chunks export provisionCloudflareResources: p1\.mjs, p2\.mjs/
	);
	await assert.rejects(
		loadVoidProvisioning(
			fakeVoid(t, validatedVersion, {
				"c.mjs": CONFIG_CHUNK,
				"p.mjs":
					"const provisionCloudflareResources = 1;\nexport { provisionCloudflareResources as g };\n",
			})
		),
		/p\.mjs exports provisionCloudflareResources as g, but it is not a function/
	);
	await assert.rejects(
		loadVoidProvisioning(
			fakeVoid(t, validatedVersion, { "bad.mjs": "export { a as };\n" })
		),
		/bad\.mjs: malformed export specifier/
	);
});

test("bounds the chunk scan", (t) => {
	const entry = fakeVoid(t, validatedVersion, {
		"long.mjs": `export { ${"a".repeat(EXPORT_TAIL_BYTES)} };`,
	});
	assert.throws(
		() => readChunks(new URL("./", entry)),
		/long\.mjs: final line exceeds EXPORT_TAIL_BYTES/
	);
	const many = Object.fromEntries(
		Array.from({ length: CHUNK_COUNT_MAX + 1 }, (_, i) => [
			`c${i}.mjs`,
			"export {};\n",
		])
	);
	assert.throws(
		() => readChunks(new URL("./", fakeVoid(t, validatedVersion, many))),
		/Void chunks exceed CHUNK_COUNT_MAX/
	);
});

// The pinned package, through a separate process as deploy loads it.
test("the installed Void is validated and exposes every internal", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { loadVoidProvisioning } from "./scripts/lib/void-cloudflare.ts";
const sdk = await loadVoidProvisioning();
console.log(JSON.stringify(Object.fromEntries(Object.entries(sdk).map(([k, v]) => [k, typeof v === "function" ? "function" : v]))));`,
		],
		{ encoding: "utf8" }
	);
	assert.equal(result.status, 0, result.stderr);
	const loaded: unknown = JSON.parse(result.stdout);
	assert.deepEqual(loaded, {
		version: validatedVersion,
		provisionCloudflareResources: "function",
		materializeCloudflareConfig: "function",
		persistCloudflareConfig: "function",
	});
});
