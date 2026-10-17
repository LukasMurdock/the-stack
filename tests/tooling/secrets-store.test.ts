import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SECRETS_STORE_ID_UNPROVISIONED } from "../../config/cloudflare.mjs";
import {
	runWrangler,
	type WranglerResult,
} from "../../scripts/lib/flagship.ts";
import {
	artifactSecretProblems,
	DEFAULT_STORE_NAME,
	ensureSecretsStore,
	LIST_PAGE_SIZE,
	listStoreSecretNames,
	parseWranglerTable,
	secretsConfigProblems,
	seedLocalSecrets,
} from "../../scripts/lib/secrets-store.ts";
import {
	provisionSecretsStore,
	readCloudflareConfig,
} from "../../scripts/provision-resources.mjs";
import {
	type Artifact,
	expectedFromConfig,
	verifyArtifact,
} from "../../scripts/testing/deploy-artifact.ts";

const STORE_ID = "a".repeat(32);
const OTHER_STORE_ID = "b".repeat(32);
const root = path.resolve(import.meta.dirname, "../..");

function tempDir(t: TestContext, prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

// Wrangler's cli-table3 rendering, as `secrets-store ... list` prints it.
function table(rows: readonly Readonly<Record<string, string>>[]): string {
	const [first] = rows;
	if (first === undefined) return "";
	const header = Object.keys(first);
	const line = (cells: readonly string[]) => `│ ${cells.join(" │ ")} │`;
	return [
		" ⛅️ wrangler 4.151.0",
		"🔐 Listing...",
		`┌${"─".repeat(10)}┐`,
		line(header),
		...rows.flatMap((row) => [
			`├${"─".repeat(10)}┤`,
			line(header.map((key) => row[key] ?? "")),
		]),
		`└${"─".repeat(10)}┘`,
	].join("\n");
}

const ok = (stdout: string): WranglerResult => ({
	status: 0,
	stdout,
	stderr: "",
});
const fail = (stderr: string): WranglerResult => ({
	status: 1,
	stdout: "",
	stderr,
});

const productionLike = {
	name: "fixture-stack",
	compatibility_date: "2025-10-08",
	secrets_store_secrets: [
		{
			binding: "BETTER_AUTH_SECRET",
			store_id: SECRETS_STORE_ID_UNPROVISIONED,
			secret_name: "FIXTURE_STACK_BETTER_AUTH_SECRET",
		},
	],
};

test("the table parser reads Wrangler's real local Secrets Store listing", (t) => {
	const directory = tempDir(t, "stack-secrets-table-");
	const configPath = path.join(directory, "wrangler.json");
	writeFileSync(
		configPath,
		JSON.stringify({ name: "table-cli", compatibility_date: "2025-10-08" })
	);
	const persistTo = path.join(directory, "state");
	seedLocalSecrets(
		{
			persistTo,
			storeId: STORE_ID,
			configPath,
			secrets: { FIRST_SECRET: "one", SECOND_SECRET: "two" },
		},
		runWrangler
	);
	const listed = runWrangler([
		"secrets-store",
		"secret",
		"list",
		STORE_ID,
		"--persist-to",
		persistTo,
		"--config",
		configPath,
	]);
	assert.equal(listed.status, 0, listed.stderr);
	const rows = parseWranglerTable(listed.stdout);
	assert.deepEqual(
		rows.map((row) => row.Name),
		["FIRST_SECRET", "SECOND_SECRET"]
	);
	assert.ok(rows.every((row) => /^[0-9a-f]{32}$/.test(row.ID ?? "")));
	assert.deepEqual(parseWranglerTable("no table here"), []);
});

test("the config guard refuses plain secrets, env.ts and an unbound required secret", (t) => {
	const directory = tempDir(t, "stack-secrets-config-");
	assert.deepEqual(secretsConfigProblems(productionLike, directory), []);
	const problems = secretsConfigProblems(
		{
			name: "fixture-stack",
			secrets: { required: ["BETTER_AUTH_SECRET", "RESEND_API_KEY"] },
		},
		directory
	).join("\n");
	assert.match(
		problems,
		/plain Worker secrets \(secrets\.required: BETTER_AUTH_SECRET, RESEND_API_KEY\)/
	);
	assert.match(problems, /Void pins a live Worker's plain secrets/);
	assert.match(problems, /cannot upload FLAGS \(Flagship\) or ANALYTICS_SQL/);
	assert.match(problems, /Secrets Store/);
	assert.match(
		problems,
		/does not bind the required secret BETTER_AUTH_SECRET from Secrets Store/
	);
	writeFileSync(path.join(directory, "env.ts"), "export default {};\n");
	assert.match(
		secretsConfigProblems(productionLike, directory).join("\n"),
		/env\.ts declares an env schema/
	);
	// The template itself passes.
	assert.deepEqual(
		secretsConfigProblems(readCloudflareConfigFromVoid(), root),
		[]
	);
});

function readCloudflareConfigFromVoid(): unknown {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			'const m = await import("./config/cloudflare.mjs"); process.stdout.write(JSON.stringify(m.deploymentCloudflare));',
		],
		{ cwd: root, encoding: "utf8" }
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("the artifact guard refuses plain secrets and names bindings Void's pinned uploader cannot carry", () => {
	const clean = new Map([
		["FLAGS", "flagship"],
		["ANALYTICS_SQL", "analytics"],
		["BETTER_AUTH_SECRET", "secrets-store-secret"],
		["CORE_DB", "d1"],
	]);
	assert.deepEqual(artifactSecretProblems(clean), []);
	const pinned = artifactSecretProblems(
		new Map([...clean, ["LEGACY_KEY", "secret"]])
	);
	assert.match(
		pinned[0] ?? "",
		/plain secret bindings \(LEGACY_KEY: secret\)/
	);
	assert.deepEqual(pinned.slice(1), [
		"FLAGS is a flagship binding, which Void cannot upload while plain secrets are pinned.",
		"ANALYTICS_SQL is a analytics binding, which Void cannot upload while plain secrets are pinned.",
		"BETTER_AUTH_SECRET is a secrets-store-secret binding, which Void cannot upload while plain secrets are pinned.",
	]);
});

test("check:deploy compares Store bindings and fails an artifact with a plain secret", () => {
	const config = {
		name: "app",
		compatibility_date: "2025-10-08",
		secrets_store_secrets: productionLike.secrets_store_secrets,
		flagship: [{ binding: "FLAGS" }],
	};
	const expected = expectedFromConfig(config);
	assert.equal(
		expected.bindings.get("BETTER_AUTH_SECRET"),
		"secrets-store-secret"
	);
	const artifact: Artifact = {
		mainModule: "index.js",
		modules: new Map([["index.js", { type: "esm", source: "" }]]),
		bindings: new Map(expected.bindings),
		schedules: [],
	};
	assert.deepEqual(verifyArtifact(artifact, expected), []);
	const withPlain = new Map(expected.bindings);
	withPlain.set("BETTER_AUTH_SECRET", "secret");
	const problems = verifyArtifact(
		{ ...artifact, bindings: withPlain },
		expected
	).join("\n");
	assert.match(problems, /BETTER_AUTH_SECRET is a secret binding/);
	assert.match(problems, /plain secret bindings/);
	assert.match(
		problems,
		/FLAGS is a flagship binding, which Void cannot upload/
	);
});

test("pnpm check:deploy refuses a config with plain secrets before building", (t) => {
	const directory = tempDir(t, "stack-secrets-check-");
	writeFileSync(
		path.join(directory, "void.config.ts"),
		`export default ${JSON.stringify({
			cloudflare: {
				name: "fixture-stack",
				compatibility_date: "2025-10-08",
				secrets: { required: ["BETTER_AUTH_SECRET"] },
			},
		})};\n`
	);
	const result = spawnSync(
		process.execPath,
		[path.join(root, "scripts/testing/deploy-artifact.ts")],
		{ cwd: directory, encoding: "utf8", timeout: 60_000 }
	);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(
		result.stderr,
		/would deploy plain Worker secrets:\n {2}- The config declares plain Worker secrets \(secrets\.required: BETTER_AUTH_SECRET\)/
	);
	assert.doesNotMatch(result.stdout, /as void deploy builds it/);
});

test("the store is reused, created when the account has none, and never guessed among several", () => {
	const configPath = "/tmp/fixture/.void-wrangler.jsonc";
	const calls: string[] = [];
	const reused = ensureSecretsStore({ configPath }, (args) => {
		calls.push(args.slice(0, 3).join(" "));
		assert.ok(args.includes("--remote"));
		return ok(table([{ Name: "default_secrets_store", ID: STORE_ID }]));
	});
	assert.deepEqual(reused, { storeId: STORE_ID, action: "reused" });
	assert.deepEqual(calls, ["secrets-store store list"]);

	const created = ensureSecretsStore({ configPath }, (args) => {
		if (args[2] === "list")
			return fail("✘ [ERROR] List request returned no stores.");
		assert.deepEqual(args.slice(0, 4), [
			"secrets-store",
			"store",
			"create",
			DEFAULT_STORE_NAME,
		]);
		return ok(
			`🔐 Creating store... (Name: ${DEFAULT_STORE_NAME})\n✅ Created store! (Name: ${DEFAULT_STORE_NAME}, ID: ${OTHER_STORE_ID})\n`
		);
	});
	assert.deepEqual(created, { storeId: OTHER_STORE_ID, action: "created" });

	assert.throws(
		() =>
			ensureSecretsStore({ configPath }, () =>
				ok(
					table([
						{ Name: "one", ID: STORE_ID },
						{ Name: "two", ID: OTHER_STORE_ID },
					])
				)
			),
		/several Secrets Stores \(one a{32}, two b{32}\)\. Set store_id/
	);
	assert.throws(
		() =>
			ensureSecretsStore({ configPath }, () =>
				fail("Authentication error [code: 10000]")
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Authentication error/);
			assert.match(
				error.message,
				/pnpm exec wrangler secrets-store store create default_secrets_store --remote/
			);
			assert.match(error.message, /Secrets Store Write/);
			return true;
		}
	);
});

test("store listings are read page by page within a bound", () => {
	const pages: number[] = [];
	const full = Array.from({ length: LIST_PAGE_SIZE }, (_, index) => ({
		Name: `SECRET_${index}`,
	}));
	const names = listStoreSecretNames(
		{ storeId: STORE_ID, configPath: "/tmp/c.json" },
		(args) => {
			const page = Number(args[args.indexOf("--page") + 1]);
			pages.push(page);
			if (page === 1) return ok(table(full));
			if (page === 2) return ok(table([{ Name: "LAST" }]));
			throw new Error("read past the last page");
		}
	);
	assert.deepEqual(pages, [1, 2]);
	assert.equal(names.size, LIST_PAGE_SIZE + 1);
	assert.ok(names.has("LAST"));
	assert.equal(
		listStoreSecretNames(
			{ storeId: STORE_ID, configPath: "/tmp/c.json" },
			() => fail("✘ [ERROR] List request returned no secrets.")
		).size,
		0
	);
});

type FakeAccount = {
	readonly stores: readonly string[];
	readonly secrets: readonly string[];
	readonly workerSecrets: readonly string[] | "no-worker";
};

function fakeAccount(account: FakeAccount, calls: string[]) {
	return (args: readonly string[]): WranglerResult => {
		calls.push(args.slice(0, 3).join(" "));
		if (args[0] === "secret" && args[1] === "list") {
			if (account.workerSecrets === "no-worker")
				return fail(
					"This Worker does not exist on your account. [code: 10007]"
				);
			return ok(
				JSON.stringify(
					account.workerSecrets.map((name) => ({
						name,
						type: "secret_text",
					}))
				)
			);
		}
		if (args[1] === "store" && args[2] === "list")
			return ok(
				table(
					account.stores.map((id, index) => ({
						Name: `s${index}`,
						ID: id,
					}))
				)
			);
		if (args[1] === "secret" && args[2] === "list") {
			if (account.secrets.length === 0)
				return fail("List request returned no secrets.");
			return ok(table(account.secrets.map((Name) => ({ Name }))));
		}
		throw new Error(`Unexpected wrangler call: ${args.join(" ")}`);
	};
}

function writeMaterialized(directory: string, config: unknown): string {
	const configPath = path.join(directory, ".void-wrangler.jsonc");
	writeFileSync(
		configPath,
		`// void:managed-queues:v1:abc\n${JSON.stringify(config)}\n`
	);
	return configPath;
}

test("deploy records the account's store, and stops with the command for each missing secret", (t) => {
	const directory = tempDir(t, "stack-secrets-provision-");
	const persisted: string[] = [];
	const persist = (dir: string) => persisted.push(dir);
	const calls: string[] = [];

	let configPath = writeMaterialized(directory, productionLike);
	assert.throws(
		() =>
			provisionSecretsStore(
				directory,
				configPath,
				persist,
				fakeAccount(
					{
						stores: [STORE_ID],
						secrets: ["OTHER"],
						workerSecrets: [],
					},
					calls
				)
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(
				error.message,
				/missing FIXTURE_STACK_BETTER_AUTH_SECRET \(bound as BETTER_AUTH_SECRET\)/
			);
			assert.match(
				error.message,
				new RegExp(
					`pnpm exec wrangler secrets-store secret create ${STORE_ID} --name FIXTURE_STACK_BETTER_AUTH_SECRET --scopes workers --remote`
				)
			);
			return true;
		}
	);
	assert.deepEqual(persisted, [], "nothing is recorded before secrets exist");

	calls.length = 0;
	const store = provisionSecretsStore(
		directory,
		configPath,
		persist,
		fakeAccount(
			{
				stores: [STORE_ID],
				secrets: ["FIXTURE_STACK_BETTER_AUTH_SECRET"],
				workerSecrets: "no-worker",
			},
			calls
		)
	);
	assert.deepEqual(store, { storeId: STORE_ID, action: "reused" });
	assert.deepEqual(persisted, [directory]);
	assert.match(
		readFileSync(configPath, "utf8"),
		/^\/\/ void:managed-queues:v1:abc\n/
	);
	const resolved = readCloudflareConfig(configPath);
	assert.deepEqual(resolved.secrets_store_secrets, [
		{ ...productionLike.secrets_store_secrets[0], store_id: STORE_ID },
	]);
	assert.deepEqual(calls, [
		"secrets-store store list",
		"secrets-store secret list",
		"secret list --name",
	]);

	// A recorded store ID is reused without listing stores.
	calls.length = 0;
	assert.equal(
		provisionSecretsStore(
			directory,
			configPath,
			persist,
			fakeAccount(
				{
					stores: [],
					secrets: ["FIXTURE_STACK_BETTER_AUTH_SECRET"],
					workerSecrets: [],
				},
				calls
			)
		),
		undefined
	);
	assert.deepEqual(calls, [
		"secrets-store secret list",
		"secret list --name",
	]);

	// A Worker deployed with plain secrets needs the one-time switch.
	configPath = writeMaterialized(directory, productionLike);
	assert.throws(
		() =>
			provisionSecretsStore(
				directory,
				configPath,
				persist,
				fakeAccount(
					{
						stores: [STORE_ID],
						secrets: ["FIXTURE_STACK_BETTER_AUTH_SECRET"],
						workerSecrets: ["BETTER_AUTH_SECRET", "RESEND_API_KEY"],
					},
					calls
				)
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(
				error.message,
				/fixture-stack has plain Worker secrets: BETTER_AUTH_SECRET, RESEND_API_KEY/
			);
			assert.match(
				error.message,
				/pnpm exec wrangler deploy --config dist\/server\/wrangler\.json/
			);
			assert.match(
				error.message,
				/pnpm exec wrangler secret delete RESEND_API_KEY --name fixture-stack/
			);
			return true;
		}
	);
	// The store was still recorded, so the switch's build binds it.
	assert.equal(
		readCloudflareConfig(configPath).secrets_store_secrets?.[0]?.store_id,
		STORE_ID
	);

	configPath = writeMaterialized(directory, {
		...productionLike,
		secrets: { required: ["BETTER_AUTH_SECRET"] },
	});
	assert.throws(
		() =>
			provisionSecretsStore(directory, configPath, persist, () => {
				throw new Error("no Wrangler call for a refused config");
			}),
		/plain Worker secrets \(secrets\.required: BETTER_AUTH_SECRET\)/
	);
});
